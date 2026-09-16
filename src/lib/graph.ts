// Commit graph lane layout. Commits must be in topological order (parents
// after children), which is what the backend's revwalk produces.

export interface GraphInput {
  oid: string;
  parents: string[];
  wip?: boolean;
}

export interface Edge {
  lane: number;
  color: number;
  dashed: boolean;
}

export interface RowLayout {
  lane: number;
  color: number;
  dashed: boolean;
  /** A line enters the node from above in its own lane. */
  fromTop: boolean;
  /** Lines from other lanes above that end at this node. */
  incoming: Edge[];
  /** Lines from this node to the lanes of its parents below. */
  outgoing: Edge[];
  /** Lanes passing straight through this row. */
  passing: Edge[];
  isMerge: boolean;
  isWip: boolean;
}

export const WIP_COLOR = -1;

export function layoutGraph(rows: GraphInput[]): { rows: RowLayout[]; maxLanes: number } {
  const lanes: (string | null)[] = [];
  const laneColor: number[] = [];
  const laneDashed: boolean[] = [];
  let nextColor = 0;
  let maxLanes = 0;
  const out: RowLayout[] = [];

  const firstFree = (): number => {
    for (let j = 0; j < lanes.length; j++) if (lanes[j] === null) return j;
    lanes.push(null);
    laneColor.push(0);
    laneDashed.push(false);
    return lanes.length - 1;
  };

  for (const row of rows) {
    let lane = -1;
    const incoming: Edge[] = [];
    for (let j = 0; j < lanes.length; j++) {
      if (lanes[j] === row.oid) {
        if (lane === -1) lane = j;
        else {
          incoming.push({ lane: j, color: laneColor[j], dashed: laneDashed[j] });
          lanes[j] = null;
        }
      }
    }
    const fromTop = lane !== -1;
    if (lane === -1) {
      lane = firstFree();
      lanes[lane] = row.oid;
      laneColor[lane] = row.wip ? WIP_COLOR : nextColor++;
      laneDashed[lane] = !!row.wip;
    }
    // A real commit reached through the WIP lane takes over with a proper color.
    if (!row.wip && laneColor[lane] === WIP_COLOR) laneColor[lane] = nextColor++;
    const color = laneColor[lane];
    const dashed = laneDashed[lane];

    const passing: Edge[] = [];
    for (let j = 0; j < lanes.length; j++) {
      if (j !== lane && lanes[j] !== null) passing.push({ lane: j, color: laneColor[j], dashed: laneDashed[j] });
    }

    const outgoing: Edge[] = [];
    const parents = row.parents;
    if (parents.length === 0) {
      lanes[lane] = null;
    } else {
      // The first parent always continues in this lane, even if another lane
      // already expects the same commit: the lanes converge (leftmost wins)
      // on the parent's row, which keeps the main line straight.
      lanes[lane] = parents[0];
      // A WIP lane stays dashed until it reaches HEAD; a real commit's lane
      // continues solid with the same color.
      laneDashed[lane] = !!row.wip;
      outgoing.push({ lane, color: laneColor[lane], dashed: !!row.wip });
      for (let i = 1; i < parents.length; i++) {
        const p = parents[i];
        let ex = -1;
        for (let j = 0; j < lanes.length; j++) {
          if (lanes[j] === p) {
            ex = j;
            break;
          }
        }
        if (ex !== -1) {
          outgoing.push({ lane: ex, color: laneColor[ex], dashed: false });
        } else {
          const k = firstFree();
          lanes[k] = p;
          laneColor[k] = nextColor++;
          laneDashed[k] = false;
          outgoing.push({ lane: k, color: laneColor[k], dashed: false });
        }
      }
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
      laneColor.pop();
      laneDashed.pop();
    }
    const width = Math.max(lane + 1, lanes.length, ...incoming.map((e) => e.lane + 1), ...outgoing.map((e) => e.lane + 1));
    if (width > maxLanes) maxLanes = width;

    out.push({
      lane,
      color,
      dashed,
      fromTop,
      incoming,
      outgoing,
      passing,
      isMerge: parents.length > 1,
      isWip: !!row.wip,
    });
  }
  return { rows: out, maxLanes };
}

export const GRAPH_COLORS = [
  "#4f8cff",
  "#f778ba",
  "#ffb454",
  "#32d296",
  "#c678dd",
  "#56d4dd",
  "#ff7b72",
  "#e5c07b",
  "#7ee787",
  "#79c0ff",
  "#ff9e64",
  "#a5d6ff",
];

/** Lane colors are theme-aware CSS variables (see styles.css). */
export function laneColorCss(color: number): string {
  if (color === WIP_COLOR) return "var(--lane-wip)";
  return `var(--lane-${color % GRAPH_COLORS.length})`;
}
