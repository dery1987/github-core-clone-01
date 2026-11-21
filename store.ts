// In-memory store placeholder. Backed by Maps; to be filled in by the
// build team with repositories, issues, and pull requests.

export interface Repo {
  name: string;
  owner: string;
}

export interface Issue {
  id: number;
  repo: string;
  title: string;
}

export interface PullRequest {
  id: number;
  repo: string;
  title: string;
}

export const store = {
  repos: new Map<string, Repo>(),
  issues: new Map<number, Issue>(),
  pullRequests: new Map<number, PullRequest>(),
};

// Deterministic export: sorted keys, no timestamps, so state snapshots
// are byte-stable across runs.
export function exportState(): string {
  const sorted = <T>(entries: Array<[string | number, T]>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [key, value] of [...entries].sort(([a], [b]) =>
      String(a).localeCompare(String(b)),
    )) {
      out[String(key)] = value;
    }
    return out;
  };
  return JSON.stringify(
    {
      issues: sorted([...store.issues.entries()]),
      pullRequests: sorted([...store.pullRequests.entries()]),
      repos: sorted([...store.repos.entries()]),
    },
    null,
    2,
  );
}
