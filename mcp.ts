// The MCP endpoint (Streamable HTTP, JSON answers): the modern 2026-07-28 era via
// server/discover, with the legacy initialize handshake answered too. The six tools are
// github-mcp-server's shapes over the same store as REST: an object created here is the
// same object there, with the same ids.

import { VIEWER, type Forge, type RepoRec } from './core.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Reply } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (forge: Forge, args: Record<string, unknown>) => unknown;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function repoOf(forge: Forge, args: Record<string, unknown>): RepoRec {
  const owner = str(args, 'owner') ?? VIEWER.login;
  const repoName = str(args, 'repo');
  if (repoName === undefined) throw new ToolError('repo is required');
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) throw new ToolError(`repository ${owner}/${repoName} not found`);
  return repo;
}

class ToolError extends Error {}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run: (forge, args) => {
      const name = str(args, 'name');
      if (name === undefined) throw new ToolError('name is required');
      const repo = forge.createRepo(VIEWER.login, name, args.private === true, str(args, 'description') ?? '');
      if (repo === null) throw new ToolError(`a repository named ${name} already exists`);
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => repoJson(repoOf(forge, args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to attach.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const title = str(args, 'title');
      if (title === undefined) throw new ToolError('title is required');
      const labels = Array.isArray(args.labels) ? args.labels.filter((label): label is string => typeof label === 'string') : [];
      const issue = forge.createIssue(repo, title, str(args, 'body') ?? '', labels);
      if (issue === null) throw new ToolError('one or more labels do not exist');
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all (default open).' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const state = str(args, 'state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.seq - b.seq);
      return issues.map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const title = str(args, 'title');
      const head = str(args, 'head');
      const base = str(args, 'base');
      if (title === undefined || head === undefined || base === undefined) throw new ToolError('title, head and base are required');
      const pull = forge.createPull(repo, title, str(args, 'body') ?? '', head, base);
      if (pull === 'missing-ref') throw new ToolError('head or base branch does not exist');
      if (pull === 'duplicate') throw new ToolError('a pull request already exists for this head and base');
      return pullJson(forge, repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) throw new ToolError(`pull request #${String(args.pull_number)} not found`);
      const result = forge.mergePull(repo, pull);
      if (result === 'conflict') throw new ToolError('pull request is not mergeable because of conflicts');
      if (result === 'not-open') throw new ToolError('pull request is not open');
      return pullJson(forge, repo, pull);
    },
  },
];

const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
};

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function toolResult(payload: unknown): Record<string, unknown> {
  const text = JSON.stringify(payload) ?? 'null';
  const result: Record<string, unknown> = { content: [{ type: 'text', text }], isError: false };
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    result.structuredContent = payload;
  }
  return result;
}

function handleRpc(forge: Forge, request: Record<string, unknown>): Record<string, unknown> | null {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  if (id === undefined) return null; // A notification: acknowledged by silence (HTTP 202).
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST_RESULT);
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) return rpcError(id, -32602, `unknown tool: ${name}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const required = (tool.inputSchema.required as string[] | undefined) ?? [];
      const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) return rpcError(id, -32602, `missing required argument(s): ${missing.join(', ')}`);
      try {
        return rpcResult(id, toolResult(tool.run(forge, args)));
      } catch (err) {
        if (err instanceof ToolError) {
          return rpcResult(id, { content: [{ type: 'text', text: err.message }], isError: true });
        }
        throw err;
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export function handleMcp(forge: Forge, bodyText: string): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'parse error: the body is not JSON') };
  }
  if (Array.isArray(parsed)) {
    const responses = parsed
      .map((entry) => (entry !== null && typeof entry === 'object' ? handleRpc(forge, entry as Record<string, unknown>) : null))
      .filter((entry) => entry !== null);
    return { status: 200, body: responses };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { status: 400, body: rpcError(null, -32600, 'invalid request') };
  }
  const response = handleRpc(forge, parsed as Record<string, unknown>);
  if (response === null) return { status: 202 };
  return { status: 200, body: response };
}
