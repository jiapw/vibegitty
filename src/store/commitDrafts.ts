import { create } from "zustand";

interface CommitDraft {
  summary: string;
  body: string;
  amend: boolean;
}

export const emptyDraft: CommitDraft = { summary: "", body: "", amend: false };

export const useCommitDrafts = create<{
  drafts: Record<string, CommitDraft>;
  update: (path: string, changes: Partial<CommitDraft>) => void;
  clear: (path: string) => void;
}>((set) => ({
  drafts: {},
  update: (path, changes) => set(({ drafts }) => ({
    drafts: { ...drafts, [path]: { ...emptyDraft, ...drafts[path], ...changes } },
  })),
  clear: (path) => set(({ drafts }) => {
    const next = { ...drafts };
    delete next[path];
    return { drafts: next };
  }),
}));
