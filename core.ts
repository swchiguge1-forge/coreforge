// The forge's domain state and operations, shared by every surface (git smart HTTP, REST,
// GraphQL, MCP) so an object created on one surface is the same object on all the others.
// Everything lives in memory; timestamps come from a deterministic logical clock so two
// identical request sequences produce identical state.

import {
  ObjectStore,
  ZERO_OID,
  buildCommit,
  buildTreeFromFlat,
  closureOf,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  treeEntryAt,
  type GitObject,
} from './git.ts';

export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const DEFAULT_BRANCH = 'main';
const EPOCH_SEC = 1_700_000_000;

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  kind: 'issue';
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  kind: 'pull';
  number: number;
  id: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedSeq: number | null;
  seq: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  seq: number;
}

export class Forge {
  readonly store = new ObjectStore();
  readonly repos = new Map<string, RepoRec>();
  private repoSeq = 0;
  private issueIdSeq = 0;
  private commentIdSeq = 0;
  private clockSeq = 0;

  /** The next logical timestamp, in epoch seconds (deterministic; never the wall clock). */
  tick(): number {
    this.clockSeq += 1;
    return EPOCH_SEC + this.clockSeq;
  }

  isoNow(): string {
    return new Date(this.tick() * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  ident(): string {
    return `${VIEWER.name} <${VIEWER.email}> ${this.tick()} +0000`;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): RepoRec | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    this.repoSeq += 1;
    const repo: RepoRec = {
      id: this.repoSeq,
      owner,
      name,
      isPrivate,
      description,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      seq: this.repoSeq,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  viewerRepos(): RepoRec[] {
    return [...this.repos.values()].filter((repo) => repo.owner === VIEWER.login).sort((a, b) => a.seq - b.seq);
  }

  // ---------------------------------------------------------------------------------------------
  // Refs and commits

  headRef(repo: RepoRec): string {
    return `refs/heads/${DEFAULT_BRANCH}`;
  }

  branchTip(repo: RepoRec, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** Resolve a branch name, a full ref, or a commit sha to a commit oid, if it names one. */
  resolveCommit(repo: RepoRec, ref: string): string | null {
    const direct = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
    const oid = direct ?? (this.store.has(ref) ? ref : undefined);
    if (oid === undefined) return null;
    return peelToCommit(this.store, oid);
  }

  /** Make a commit on top of `parent` (null = root) carrying `tree`, and store it. */
  commitOn(parent: string | null, tree: string, message: string): string {
    const ident = this.ident();
    return this.store.put('commit', buildCommit({
      tree,
      parents: parent === null ? [] : [parent],
      author: ident,
      committer: ident,
      message,
    }));
  }

  /** The flattened file map of a commit's tree (empty map for a null commit). */
  filesOf(commitOid: string | null): Map<string, { mode: string; oid: string }> {
    if (commitOid === null) return new Map();
    const object = this.store.get(commitOid);
    if (object === undefined || object.type !== 'commit') return new Map();
    return flattenTree(this.store, parseCommit(object.data).tree);
  }

  // ---------------------------------------------------------------------------------------------
  // Contents API over the git store

  /**
   * Write `content` at `path` on `branch`, creating the branch (from the default branch tip)
   * or the repository's first commit when needed. Mirrors GitHub's contents rules:
   * updating an existing file requires its current blob sha (missing = error 'missing-sha',
   * mismatched = 'stale-sha'); creating a file takes no sha.
   */
  putContent(
    repo: RepoRec,
    path: string,
    content: Buffer,
    message: string,
    branch: string | undefined,
    sha: string | undefined,
  ): { status: 'created' | 'updated'; commitSha: string; blobSha: string } | { status: 'missing-sha' | 'stale-sha' | 'bad-path' } {
    if (path === '' || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
      return { status: 'bad-path' };
    }
    const branchName = branch ?? DEFAULT_BRANCH;
    let tip = this.branchTip(repo, branchName);
    if (tip === undefined && branch !== undefined) {
      // A contents write names a branch that does not exist yet: start it from the default tip.
      tip = this.branchTip(repo, DEFAULT_BRANCH);
    }
    const files = this.filesOf(tip ?? null);
    const existing = files.get(path);
    if (existing !== undefined) {
      if (sha === undefined) return { status: 'missing-sha' };
      if (sha.toLowerCase() !== existing.oid.toLowerCase()) return { status: 'stale-sha' };
    }
    const blobSha = this.store.put('blob', content);
    files.set(path, { mode: '100644', oid: blobSha });
    const tree = buildTreeFromFlat(this.store, files);
    const commitSha = this.commitOn(tip ?? null, tree, message);
    repo.refs.set(`refs/heads/${branchName}`, commitSha);
    return { status: existing === undefined ? 'created' : 'updated', commitSha, blobSha };
  }

  deleteContent(
    repo: RepoRec,
    path: string,
    message: string,
    branch: string | undefined,
    sha: string | undefined,
  ): { status: 'deleted'; commitSha: string } | { status: 'not-found' | 'stale-sha' } {
    const branchName = branch ?? DEFAULT_BRANCH;
    const tip = this.branchTip(repo, branchName);
    if (tip === undefined) return { status: 'not-found' };
    const files = this.filesOf(tip);
    const existing = files.get(path);
    if (existing === undefined) return { status: 'not-found' };
    if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) return { status: 'stale-sha' };
    files.delete(path);
    const tree = buildTreeFromFlat(this.store, files);
    const commitSha = this.commitOn(tip, tree, message);
    repo.refs.set(`refs/heads/${branchName}`, commitSha);
    return { status: 'deleted', commitSha };
  }

  /** Read a file or directory at `path` as of `ref` (branch, tag or sha; default branch). */
  readContent(
    repo: RepoRec,
    path: string,
    ref: string | undefined,
  ): { kind: 'file'; entry: { mode: string; oid: string }; size: number } | { kind: 'dir'; treeOid: string } | null {
    const commit = this.resolveCommit(repo, ref ?? DEFAULT_BRANCH);
    if (commit === null) {
      // An unborn repository has no tree at all: only the root of an unborn repo reads as empty.
      return null;
    }
    const commitObject = this.store.get(commit);
    if (commitObject === undefined) return null;
    const rootTree = parseCommit(commitObject.data).tree;
    if (path === '') return { kind: 'dir', treeOid: rootTree };
    const entry = treeEntryAt(this.store, rootTree, path);
    if (entry === null) return null;
    if (entry.mode === '40000' || entry.mode === '040000') return { kind: 'dir', treeOid: entry.oid };
    const blob = this.store.get(entry.oid);
    return { kind: 'file', entry: { mode: entry.mode, oid: entry.oid }, size: blob?.data.length ?? 0 };
  }

  // ---------------------------------------------------------------------------------------------
  // Issues and comments

  createIssue(repo: RepoRec, title: string, body: string, labels: string[]): IssueRec | null {
    for (const label of labels) {
      if (!repo.labels.has(label)) return null;
    }
    this.issueIdSeq += 1;
    const issue: IssueRec = {
      kind: 'issue',
      number: repo.nextNumber,
      id: this.issueIdSeq,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: repo.nextNumber,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(issue: IssueRec, body: string): CommentRec {
    this.commentIdSeq += 1;
    const comment: CommentRec = { id: this.commentIdSeq, body, seq: this.commentIdSeq };
    issue.comments.push(comment);
    return comment;
  }

  // ---------------------------------------------------------------------------------------------
  // Pull requests

  createPull(repo: RepoRec, title: string, body: string, head: string, base: string): PullRec | 'missing-ref' | 'duplicate' {
    if (this.branchTip(repo, head) === undefined || this.branchTip(repo, base) === undefined) return 'missing-ref';
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.head === head && pull.base === base) return 'duplicate';
    }
    this.issueIdSeq += 1;
    const pull: PullRec = {
      kind: 'pull',
      number: repo.nextNumber,
      id: this.issueIdSeq,
      title,
      body,
      head,
      base,
      state: 'open',
      merged: false,
      mergeCommitSha: null,
      mergedSeq: null,
      seq: repo.nextNumber,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The changed files between a pull request's merge base and its head tip. */
  pullFiles(repo: RepoRec, pull: PullRec): FileChange[] {
    const headTip = this.branchTip(repo, pull.head);
    const baseTip = this.branchTip(repo, pull.base);
    if (headTip === undefined || baseTip === undefined) return [];
    const base = mergeBase(this.store, headTip, baseTip) ?? baseTip;
    return diffFiles(this.filesOf(base), this.filesOf(headTip), this.store);
  }

  pullMergeable(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    return this.tryMergeTrees(repo, pull) === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * The three-way merged file map for a pull request, or null on conflict: per path, the side
   * that changed it relative to the merge base wins; both sides changing it differently (or one
   * deleting what the other changed) is a conflict.
   */
  tryMergeTrees(repo: RepoRec, pull: PullRec): Map<string, { mode: string; oid: string }> | null {
    const headTip = this.branchTip(repo, pull.head);
    const baseTip = this.branchTip(repo, pull.base);
    if (headTip === undefined || baseTip === undefined) return null;
    const baseCommit = mergeBase(this.store, headTip, baseTip) ?? baseTip;
    const baseFiles = this.filesOf(baseCommit);
    const ourFiles = this.filesOf(baseTip);
    const theirFiles = this.filesOf(headTip);
    const merged = new Map<string, { mode: string; oid: string }>();
    const paths = new Set<string>([...baseFiles.keys(), ...ourFiles.keys(), ...theirFiles.keys()]);
    for (const path of paths) {
      const baseEntry = baseFiles.get(path);
      const ourEntry = ourFiles.get(path);
      const theirEntry = theirFiles.get(path);
      const same = (a?: { oid: string }, b?: { oid: string }): boolean => a?.oid === b?.oid;
      if (same(ourEntry, theirEntry)) {
        if (ourEntry !== undefined) merged.set(path, ourEntry);
      } else if (same(baseEntry, ourEntry)) {
        if (theirEntry !== undefined) merged.set(path, theirEntry);
      } else if (same(baseEntry, theirEntry)) {
        if (ourEntry !== undefined) merged.set(path, ourEntry);
      } else {
        return null;
      }
    }
    return merged;
  }

  /**
   * Squash-merge a pull request onto its base branch: one commit whose parent is the base tip
   * and whose tree is the three-way merge. Answers the merge commit sha, 'conflict', or
   * 'not-open' when the pull cannot be merged.
   */
  mergePull(repo: RepoRec, pull: PullRec): string | 'conflict' | 'not-open' {
    if (pull.state !== 'open' || pull.merged) return 'not-open';
    const mergedFiles = this.tryMergeTrees(repo, pull);
    if (mergedFiles === null) return 'conflict';
    const baseTip = this.branchTip(repo, pull.base);
    if (baseTip === undefined) return 'not-open';
    const tree = buildTreeFromFlat(this.store, mergedFiles);
    const commitSha = this.commitOn(baseTip, tree, `${pull.title} (#${pull.number})`);
    repo.refs.set(`refs/heads/${pull.base}`, commitSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = commitSha;
    pull.mergedSeq = this.tick();
    return commitSha;
  }

  // ---------------------------------------------------------------------------------------------
  // Fetch planning (git smart HTTP)

  /**
   * Plan a fetch: the commit set to send (with the shallow boundary) given wants, haves and an
   * optional depth or deepen. Distances are generations from the wants. The send set is the
   * closure of the included commits minus the closure of the haves.
   */
  planFetch(
    wants: readonly string[],
    haves: readonly string[],
    shallow: readonly string[],
    depth: number | null,
    deepen: number | null,
  ): { send: string[]; boundary: string[]; common: string[] } {
    const store = this.store;
    // The suite's client spells every depth request as `deepen N`, for a fresh shallow clone
    // and for deepening an existing one alike, and in both cases N is the depth the client
    // must end at (its fetch option is `depth`). So a depth or deepen of N cuts the history
    // at generation N-1 from the wants; the shallow list only feeds unshallow bookkeeping.
    let limit = Number.POSITIVE_INFINITY;
    const effectiveDepth = depth ?? deepen;
    if (effectiveDepth !== null) {
      limit = effectiveDepth - 1;
    }
    // Distance (in generations) of every commit reachable from the wants, not expanding
    // past the depth limit (a depth-1 clone of a long history touches only the tip).
    const distance = new Map<string, number>();
    let frontier: string[] = [];
    for (const want of wants) {
      const commit = peelToCommit(store, want);
      if (commit !== null && !distance.has(commit)) {
        distance.set(commit, 0);
        frontier.push(commit);
      }
    }
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (distance.get(oid)! >= limit) continue;
        const object = store.get(oid);
        if (object === undefined || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) {
          if (!distance.has(parent)) {
            distance.set(parent, distance.get(oid)! + 1);
            next.push(parent);
          }
        }
      }
      frontier = next;
    }
    const included = new Set<string>();
    for (const [oid, dist] of distance) {
      if (dist <= limit) included.add(oid);
    }
    const boundary: string[] = [];
    for (const oid of included) {
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length > 0 && parents.some((parent) => !included.has(parent))) boundary.push(oid);
    }
    // The send set: each included commit plus its own tree closure (trees and blobs of that
    // commit only — never the trees of cut-off ancestors), plus any tag objects named directly
    // by a want. Then subtract everything the client already holds (the haves' full closure).
    const sendSet = new Set<string>();
    for (const oid of included) {
      sendSet.add(oid);
      const object = store.get(oid);
      if (object !== undefined && object.type === 'commit') {
        for (const reachable of closureOf(store, [parseCommit(object.data).tree])) sendSet.add(reachable);
      }
    }
    for (const want of wants) {
      const object = store.get(want);
      if (object !== undefined && object.type === 'tag') {
        sendSet.add(want);
      }
    }
    // What the client already holds: the closure of its haves, but cut at the client's own
    // shallow boundary — a shallow client holds the boundary commit and its tree, never the
    // boundary's parents, so those must not be subtracted (a deepen would deliver nothing).
    const shallowSet = new Set<string>();
    for (const oid of shallow) {
      const commit = peelToCommit(store, oid);
      shallowSet.add(commit ?? oid);
    }
    const haveClosure = new Set<string>();
    const stack = haves.filter((oid) => store.has(oid));
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (haveClosure.has(oid)) continue;
      haveClosure.add(oid);
      const object = store.get(oid);
      if (object === undefined) continue;
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        if (!shallowSet.has(oid)) for (const parent of commit.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    for (const oid of haveClosure) sendSet.delete(oid);
    const common = haves.filter((oid) => store.has(oid) && peelToCommit(store, oid) !== null);
    return { send: [...sendSet], boundary, common };
  }
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Split text into lines for diff counting; a trailing newline does not add an empty line. */
export function textLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level diff counts between two texts (longest-common-subsequence based). */
export function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldLines = textLines(oldData);
  const newLines = textLines(newData);
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  // LCS via dynamic programming over the shorter axis; suite files are a few hundred lines.
  const rows = oldLines.length;
  const cols = newLines.length;
  const dp = new Uint32Array(cols + 1);
  for (let i = rows - 1; i >= 0; i -= 1) {
    let diagonal = 0;
    for (let j = cols - 1; j >= 0; j -= 1) {
      const above = dp[j]!;
      if (oldLines[i] === newLines[j]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j]!, dp[j + 1]!);
      diagonal = above;
    }
  }
  const common = dp[0]!;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

/** The file-level diff between two flattened trees. */
export function diffFiles(
  oldFiles: ReadonlyMap<string, { mode: string; oid: string }>,
  newFiles: ReadonlyMap<string, { mode: string; oid: string }>,
  store: ObjectStore,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set<string>([...oldFiles.keys(), ...newFiles.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = oldFiles.get(path);
    const newEntry = newFiles.get(path);
    if (oldEntry?.oid === newEntry?.oid) continue;
    const oldData = oldEntry === undefined ? null : (store.get(oldEntry.oid)?.data ?? null);
    const newData = newEntry === undefined ? null : (store.get(newEntry.oid)?.data ?? null);
    let additions = 0;
    let deletions = 0;
    if (oldData === null && newData !== null) {
      additions = textLines(newData).length;
    } else if (newData === null && oldData !== null) {
      deletions = textLines(oldData).length;
    } else if (oldData !== null && newData !== null) {
      const diff = lineDiff(oldData, newData);
      additions = diff.additions;
      deletions = diff.deletions;
    }
    changes.push({
      filename: path,
      status: oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

/** Re-export for the surfaces that need raw object access. */
export type { GitObject };
export { ZERO_OID };
