// The GitHub REST v3 surface. Every handler answers the shapes rest-client.ts's checks assert:
// JSON bodies with a `message` on errors, stable ids, Link-header pagination on the viewer's
// repository list, and the contents API backed by the real git store (see core.ts).

import {
  DEFAULT_BRANCH,
  VIEWER,
  type CommentRec,
  type Forge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './core.ts';
import { listCommits, parseCommit, parseTree } from './git.ts';

export interface Reply {
  status: number;
  body?: unknown;
  raw?: Buffer;
  contentType?: string;
  headers?: Record<string, string>;
}

const EPOCH_SEC = 1_700_000_000;

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function message(status: number, text: string): Reply {
  return { status, body: { message: text } };
}

export function userJson(login = VIEWER.login, id = VIEWER.id): Record<string, unknown> {
  return {
    login,
    id,
    node_id: Buffer.from(`User:${id}`).toString('base64'),
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
    avatar_url: '',
    html_url: '',
    url: '',
  };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, repo.owner === VIEWER.login ? VIEWER.id : repo.id),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    default_branch: DEFAULT_BRANCH,
    has_issues: true,
    has_pull_requests: true,
    created_at: iso(EPOCH_SEC + repo.seq),
    updated_at: iso(EPOCH_SEC + repo.seq),
    pushed_at: iso(EPOCH_SEC + repo.seq),
    html_url: '',
    url: '',
  };
}

export function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: [...repo.labels.keys()].indexOf(name) + 1,
    name,
    color: label?.color ?? 'ededed',
    default: false,
    description: null,
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(),
    comments: issue.comments.length,
    created_at: iso(EPOCH_SEC + repo.seq * 100_000 + issue.seq),
    updated_at: iso(EPOCH_SEC + repo.seq * 100_000 + issue.seq),
    html_url: '',
    url: '',
  };
}

export function commentJson(repo: RepoRec, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${comment.id}`).toString('base64'),
    body: comment.body,
    user: userJson(),
    created_at: iso(EPOCH_SEC + comment.seq),
    updated_at: iso(EPOCH_SEC + comment.seq),
    html_url: '',
    url: '',
  };
}

export function pullJson(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headTip = forge.branchTip(repo, pull.head) ?? '';
  const baseTip = forge.branchTip(repo, pull.base) ?? '';
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64'),
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    head: {
      ref: pull.head,
      sha: headTip,
      label: `${repo.owner}:${pull.head}`,
      repo: repoJson(repo),
    },
    base: {
      ref: pull.base,
      sha: baseTip,
      label: `${repo.owner}:${pull.base}`,
      repo: repoJson(repo),
    },
    merged: pull.merged,
    merged_at: pull.merged ? iso(pull.mergedSeq ?? EPOCH_SEC) : null,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: iso(EPOCH_SEC + repo.seq * 100_000 + pull.seq),
    updated_at: iso(EPOCH_SEC + repo.seq * 100_000 + pull.seq),
    html_url: '',
    url: '',
  };
}

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1,
  };
}

function paginate<T>(items: readonly T[], page: Page): T[] {
  const start = (page.page - 1) * page.perPage;
  return items.slice(start, start + page.perPage);
}

function linkHeader(origin: string, path: string, page: Page, total: number): string | undefined {
  const lastPage = Math.max(1, Math.ceil(total / page.perPage));
  if (page.page >= lastPage) return undefined;
  const url = `${origin}${path}?per_page=${page.perPage}&page=${page.page + 1}`;
  const last = `${origin}${path}?per_page=${page.perPage}&page=${lastPage}`;
  return `<${url}>; rel="next", <${last}>; rel="last"`;
}

export interface RestContext {
  forge: Forge;
  method: string;
  /** Path segments after /api/v3, URL-decoded. */
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  origin: string;
}

/** Parse a JSON request body; `undefined` for an empty body, the symbol BAD_JSON for garbage. */
const BAD_JSON = Symbol('bad-json');
function jsonBody(ctx: RestContext): Record<string, unknown> | typeof BAD_JSON | undefined {
  if (ctx.body.length === 0) return undefined;
  try {
    const parsed = JSON.parse(ctx.body.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return BAD_JSON;
    return parsed as Record<string, unknown>;
  } catch {
    return BAD_JSON;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function repoOf(ctx: RestContext): RepoRec | null {
  const [, owner, name] = ctx.segments;
  if (owner === undefined || name === undefined) return null;
  return ctx.forge.getRepo(owner, name) ?? null;
}

export function handleRest(ctx: RestContext): Reply {
  const { forge, method, segments } = ctx;

  // /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') return message(404, 'Not Found');
    return {
      status: 200,
      headers: { 'x-oauth-scopes': 'repo, read:org' },
      body: {
        current_user_url: `${ctx.origin}/api/v3/user`,
        current_user_repositories_url: `${ctx.origin}/api/v3/user/repos`,
        repository_url: `${ctx.origin}/api/v3/repos/{owner}/{repo}`,
        rate_limit_url: `${ctx.origin}/api/v3/rate_limit`,
        emojis_url: `${ctx.origin}/api/v3/emojis`,
      },
    };
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return message(404, 'Not Found');
    return { status: 200, body: { installed_version: '1.0.0-forge', hooks: [], git: [] } };
  }

  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    return { status: 200, body: userJson() };
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const page = pageOf(ctx.query);
      const all = forge.viewerRepos();
      const items = paginate(all, page).map(repoJson);
      const link = linkHeader(ctx.origin, '/api/v3/user/repos', page, all.length);
      return { status: 200, body: items, headers: link === undefined ? undefined : { link } };
    }
    if (method === 'POST') {
      const body = jsonBody(ctx);
      if (body === BAD_JSON) return message(400, 'Problems parsing JSON');
      const name = str(body?.name);
      if (name === undefined || name === '') return message(422, 'Repository creation failed: name is required');
      const repo = forge.createRepo(VIEWER.login, name, body?.private === true, str(body?.description) ?? '');
      if (repo === null) return message(422, 'Repository creation failed: name already exists on this account');
      return { status: 201, body: repoJson(repo) };
    }
    return message(404, 'Not Found');
  }

  if (segments[0] !== 'repos' || segments.length < 3) return message(404, 'Not Found');
  const repo = repoOf(ctx);
  if (repo === null) return message(404, 'Not Found');
  const rest = segments.slice(3);

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      const body = jsonBody(ctx);
      if (body === BAD_JSON) return message(400, 'Problems parsing JSON');
      if (body !== undefined) {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
          const target = forge.getRepo(repo.owner, body.name);
          if (target === undefined) {
            forge.repos.delete(forge.key(repo.owner, repo.name));
            repo.name = body.name;
            forge.repos.set(forge.key(repo.owner, repo.name), repo);
          }
        }
      }
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      return { status: 204 };
    }
    return message(404, 'Not Found');
  }

  // Branches.
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return { status: 200, body: branches };
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const tip = forge.branchTip(repo, branch);
      if (tip === undefined) return message(404, 'Not Found');
      const commitObject = forge.store.get(tip);
      const commit = commitObject !== undefined ? parseCommit(commitObject.data) : null;
      return {
        status: 200,
        body: {
          name: branch,
          commit: {
            sha: tip,
            commit: { message: commit?.message.replace(/\n$/, '') ?? '', tree: { sha: commit?.tree ?? '' } },
          },
          protected: false,
        },
      };
    }
    return message(404, 'Not Found');
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const shaParam = ctx.query.get('sha') ?? DEFAULT_BRANCH;
    const tip = forge.resolveCommit(repo, shaParam);
    if (tip === null) return message(409, 'Git Repository is empty');
    const page = pageOf(ctx.query);
    const all = listCommits(forge.store, tip);
    const items = paginate(all, page).map((sha) => {
      const commit = parseCommit(forge.store.get(sha)!.data);
      return {
        sha,
        commit: {
          message: commit.message.replace(/\n$/, ''),
          tree: { sha: commit.tree },
          author: { name: VIEWER.name, email: VIEWER.email, date: iso(EPOCH_SEC) },
          committer: { name: VIEWER.name, email: VIEWER.email, date: iso(EPOCH_SEC) },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      };
    });
    return { status: 200, body: items };
  }

  // Git refs (the Git Data API).
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const body = jsonBody(ctx);
      if (body === BAD_JSON) return message(400, 'Problems parsing JSON');
      const ref = str(body?.ref);
      const sha = str(body?.sha);
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return message(422, 'Validation Failed');
      if (!forge.store.has(sha)) return message(422, 'Validation Failed: object does not exist');
      if (repo.refs.has(ref)) return message(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, object: { sha, type: forge.store.get(sha)?.type ?? 'commit' } } };
    }
    if (rest.length === 2 && method === 'GET') {
      const refs = [...repo.refs.entries()].map(([ref, sha]) => ({
        ref,
        object: { sha, type: forge.store.get(sha)?.type ?? 'commit' },
      }));
      return { status: 200, body: refs };
    }
    if (rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      if (method === 'GET') {
        const sha = repo.refs.get(ref);
        if (sha === undefined) return message(404, 'Not Found');
        return { status: 200, body: { ref, object: { sha, type: forge.store.get(sha)?.type ?? 'commit' } } };
      }
      if (method === 'DELETE') {
        if (!repo.refs.delete(ref)) return message(404, 'Not Found');
        return { status: 204 };
      }
    }
    return message(404, 'Not Found');
  }

  // Contents.
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const found = forge.readContent(repo, path, ctx.query.get('ref') ?? undefined);
      if (found === null) return message(404, 'Not Found');
      if (found.kind === 'dir') {
        const tree = forge.store.get(found.treeOid);
        if (tree === undefined) return message(404, 'Not Found');
        const entries = parseTree(tree.data).map((entry) => {
          const isDir = entry.mode === '40000' || entry.mode === '040000';
          const blob = forge.store.get(entry.oid);
          return {
            type: isDir ? 'dir' : 'file',
            name: entry.name,
            path: path === '' ? entry.name : `${path}/${entry.name}`,
            sha: entry.oid,
            size: isDir ? 0 : (blob?.data.length ?? 0),
          };
        });
        return { status: 200, body: entries };
      }
      const blob = forge.store.get(found.entry.oid);
      if (blob === undefined) return message(404, 'Not Found');
      const base64 = blob.data.toString('base64');
      const wrapped = base64.replace(/(.{60})/g, '$1\n');
      return {
        status: 200,
        body: {
          type: 'file',
          name: path.split('/').pop() ?? path,
          path,
          sha: found.entry.oid,
          size: blob.data.length,
          encoding: 'base64',
          content: wrapped.endsWith('\n') ? wrapped : `${wrapped}\n`,
        },
      };
    }
    if (method === 'PUT') {
      const body = jsonBody(ctx);
      if (body === BAD_JSON) return message(400, 'Problems parsing JSON');
      const contentText = str(body?.content);
      if (contentText === undefined) return message(422, 'Validation Failed: content is required');
      const content = Buffer.from(contentText.replace(/\s+/g, ''), 'base64');
      const result = forge.putContent(
        repo,
        path,
        content,
        str(body?.message) ?? '',
        str(body?.branch),
        str(body?.sha),
      );
      if (result.status === 'missing-sha') return message(422, 'Validation Failed: sha must be supplied when updating an existing file');
      if (result.status === 'stale-sha') return message(409, 'Conflict: the sha does not match the current file');
      if (result.status === 'bad-path') return message(422, 'Validation Failed: invalid path');
      return {
        status: result.status === 'created' ? 201 : 200,
        body: {
          content: {
            type: 'file',
            name: path.split('/').pop() ?? path,
            path,
            sha: result.blobSha,
            size: content.length,
            encoding: 'base64',
          },
          commit: { sha: result.commitSha },
        },
      };
    }
    if (method === 'DELETE') {
      const body = jsonBody(ctx);
      if (body === BAD_JSON) return message(400, 'Problems parsing JSON');
      const result = forge.deleteContent(repo, path, str(body?.message) ?? '', str(body?.branch), str(body?.sha));
      if (result.status === 'not-found') return message(404, 'Not Found');
      if (result.status === 'stale-sha') return message(409, 'Conflict: the sha does not match the current file');
      return { status: 200, body: { content: null, commit: { sha: result.commitSha } } };
    }
    return message(404, 'Not Found');
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'POST') {
      const body = jsonBody(ctx);
      if (body === BAD_JSON) return message(400, 'Problems parsing JSON');
      const name = str(body?.name);
      if (name === undefined || name === '') return message(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return message(422, 'Validation Failed: label already exists');
      repo.labels.set(name, { name, color: str(body?.color) ?? 'ededed' });
      return { status: 201, body: labelJson(repo, name) };
    }
    if (rest.length === 1 && method === 'GET') {
      return { status: 200, body: [...repo.labels.keys()].map((name) => labelJson(repo, name)) };
    }
    return message(404, 'Not Found');
  }

  // Issues and their comments.
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = jsonBody(ctx);
        if (body === BAD_JSON) return message(400, 'Problems parsing JSON');
        const labels = Array.isArray(body?.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
        const issue = forge.createIssue(repo, str(body?.title) ?? '', str(body?.body) ?? '', labels);
        if (issue === null) return message(422, 'Validation Failed: one or more labels do not exist');
        return { status: 201, body: issueJson(repo, issue) };
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const direction = ctx.query.get('direction') ?? 'desc';
        let items = [...repo.issues.values()];
        if (state === 'open' || state === 'closed') items = items.filter((issue) => issue.state === state);
        items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const page = pageOf(ctx.query);
        return { status: 200, body: paginate(items, page).map((issue) => issueJson(repo, issue)) };
      }
      return message(404, 'Not Found');
    }
    const number = Number(rest[1]);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (rest.length === 2) {
      if (issue === undefined) return message(404, 'Not Found');
      if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
      if (method === 'PATCH') {
        const body = jsonBody(ctx);
        if (body === BAD_JSON) return message(400, 'Problems parsing JSON');
        if (body !== undefined) {
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (Array.isArray(body.labels)) {
            const labels = body.labels.filter((label): label is string => typeof label === 'string');
            for (const label of labels) if (!repo.labels.has(label)) return message(422, 'Validation Failed: label does not exist');
            issue.labels = labels;
          }
        }
        return { status: 200, body: issueJson(repo, issue) };
      }
      return message(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) return message(404, 'Not Found');
      if (method === 'POST') {
        const body = jsonBody(ctx);
        if (body === BAD_JSON) return message(400, 'Problems parsing JSON');
        const comment = forge.addComment(issue, str(body?.body) ?? '');
        return { status: 201, body: commentJson(repo, comment) };
      }
      if (method === 'GET') {
        const page = pageOf(ctx.query);
        return { status: 200, body: paginate(issue.comments, page).map((comment) => commentJson(repo, comment)) };
      }
      return message(404, 'Not Found');
    }
    return message(404, 'Not Found');
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = jsonBody(ctx);
        if (body === BAD_JSON) return message(400, 'Problems parsing JSON');
        const head = stripOwnerPrefix(str(body?.head) ?? '');
        const base = stripOwnerPrefix(str(body?.base) ?? '');
        const pull = forge.createPull(repo, str(body?.title) ?? '', str(body?.body) ?? '', head, base);
        if (pull === 'missing-ref') return message(422, 'Validation Failed: head or base branch does not exist');
        if (pull === 'duplicate') return message(422, 'Validation Failed: a pull request already exists for this head and base');
        return { status: 201, body: pullJson(forge, repo, pull) };
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let items = [...repo.pulls.values()];
        if (state === 'open') items = items.filter((pull) => pull.state === 'open' && !pull.merged);
        else if (state === 'closed') items = items.filter((pull) => pull.state === 'closed' || pull.merged);
        items.sort((a, b) => b.seq - a.seq);
        const page = pageOf(ctx.query);
        return { status: 200, body: paginate(items, page).map((pull) => pullJson(forge, repo, pull)) };
      }
      return message(404, 'Not Found');
    }
    const number = Number(rest[1]);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (rest.length === 2 && method === 'GET') {
      if (pull === undefined) return message(404, 'Not Found');
      return { status: 200, body: pullJson(forge, repo, pull) };
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (pull === undefined) return message(404, 'Not Found');
      const page = pageOf(ctx.query);
      const files = forge.pullFiles(repo, pull).map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        sha: '',
      }));
      return { status: 200, body: paginate(files, page) };
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) return message(404, 'Not Found');
      const body = jsonBody(ctx);
      if (body === BAD_JSON) return message(400, 'Problems parsing JSON');
      if (pull.merged) return message(405, 'Pull Request is not mergeable');
      const result = forge.mergePull(repo, pull);
      if (result === 'conflict') return message(405, 'Pull Request is not mergeable because of conflicts');
      if (result === 'not-open') return message(405, 'Pull Request is not mergeable');
      return { status: 200, body: { sha: result, merged: true, message: 'Pull Request successfully merged' } };
    }
    return message(404, 'Not Found');
  }

  return message(404, 'Not Found');
}

/** gh names a head as `owner:branch` (or `owner/repo:branch`); the forge stores the branch. */
function stripOwnerPrefix(ref: string): string {
  const colon = ref.lastIndexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}
