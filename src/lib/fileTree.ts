// Build a folder tree from a flat list of paths (for the "tree" file view).
// Single-child folder chains are compacted into one row ("a/b/c"), like VS Code.

export interface FileNode<T> {
  kind: "file";
  key: string;
  name: string;
  depth: number;
  item: T;
}

export interface FolderNode<T> {
  kind: "folder";
  key: string;
  name: string;
  depth: number;
  children: TreeNode<T>[];
  /** Every file item below this folder (recursively). */
  files: T[];
}

export type TreeNode<T> = FileNode<T> | FolderNode<T>;

interface Build<T> {
  name: string;
  path: string;
  folders: Map<string, Build<T>>;
  files: { name: string; item: T }[];
}

export function buildFileTree<T>(items: T[], pathOf: (t: T) => string): TreeNode<T>[] {
  const root: Build<T> = { name: "", path: "", folders: new Map(), files: [] };
  for (const item of items) {
    const full = pathOf(item);
    const parts = full.split("/").filter(Boolean);
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let next = cur.folders.get(seg);
      if (!next) {
        next = { name: seg, path: cur.path ? `${cur.path}/${seg}` : seg, folders: new Map(), files: [] };
        cur.folders.set(seg, next);
      }
      cur = next;
    }
    cur.files.push({ name: parts[parts.length - 1] ?? full, item });
  }

  const collect = (nodes: TreeNode<T>[], out: T[]) => {
    for (const n of nodes) {
      if (n.kind === "file") out.push(n.item);
      else out.push(...n.files);
    }
  };

  const convert = (b: Build<T>, depth: number): TreeNode<T>[] => {
    const out: TreeNode<T>[] = [];
    const folders = [...b.folders.values()].sort((x, y) => x.name.localeCompare(y.name));
    for (let f of folders) {
      let name = f.name;
      while (f.files.length === 0 && f.folders.size === 1) {
        const only = [...f.folders.values()][0];
        name = `${name}/${only.name}`;
        f = only;
      }
      const children = convert(f, depth + 1);
      const files: T[] = [];
      collect(children, files);
      out.push({ kind: "folder", key: f.path, name, depth, children, files });
    }
    for (const fl of [...b.files].sort((x, y) => x.name.localeCompare(y.name))) {
      out.push({ kind: "file", key: pathOf(fl.item), name: fl.name, depth, item: fl.item });
    }
    return out;
  };
  return convert(root, 0);
}

/** Rows to render given the collapsed folder keys. */
export function flattenFileTree<T>(nodes: TreeNode<T>[], collapsed: Record<string, boolean>, out: TreeNode<T>[] = []): TreeNode<T>[] {
  for (const n of nodes) {
    out.push(n);
    if (n.kind === "folder" && !collapsed[n.key]) flattenFileTree(n.children, collapsed, out);
  }
  return out;
}
