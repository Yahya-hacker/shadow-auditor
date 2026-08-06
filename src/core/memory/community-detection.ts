/**
 * Louvain-style community detection for the knowledge graph.
 *
 * This is a pure TypeScript implementation that runs the first phase of the
 * Louvain algorithm (node moving) repeatedly until modularity stops improving.
 * It is used as a pragmatic, dependency-free substitute for Leiden/Louvain.
 */

export interface LouvainGraph {
  edges: Array<[string, string]>;
  nodes: string[];
}

export interface CommunityAssignment {
  communities: Map<string, number>;
  modularity: number;
}

function buildAdjacencyList(edges: Array<[string, string]>): Map<string, Map<string, number>> {
  const adjacency = new Map<string, Map<string, number>>();

  for (const [source, target] of edges) {
    if (!adjacency.has(source)) adjacency.set(source, new Map());
    if (!adjacency.has(target)) adjacency.set(target, new Map());

    const sourceNeighbors = adjacency.get(source)!;
    sourceNeighbors.set(target, (sourceNeighbors.get(target) ?? 0) + 1);

    const targetNeighbors = adjacency.get(target)!;
    targetNeighbors.set(source, (targetNeighbors.get(source) ?? 0) + 1);
  }

  return adjacency;
}

function computeModularity(
  adjacency: Map<string, Map<string, number>>,
  communities: Map<string, number>,
  totalWeight: number,
): number {
  if (totalWeight === 0) return 0;

  const communityDegrees = new Map<number, number>();
  const communityInternalWeights = new Map<number, number>();

  for (const [node, neighbors] of adjacency) {
    const community = communities.get(node) ?? -1;
    const nodeDegree = [...neighbors.values()].reduce((sum, w) => sum + w, 0);

    communityDegrees.set(community, (communityDegrees.get(community) ?? 0) + nodeDegree);

    for (const [neighbor, weight] of neighbors) {
      if (communities.get(neighbor) === community) {
        communityInternalWeights.set(community, (communityInternalWeights.get(community) ?? 0) + weight);
      }
    }
  }

  let modularity = 0;
  for (const [community, internalWeight] of communityInternalWeights) {
    const communityDegree = communityDegrees.get(community) ?? 0;
    modularity += internalWeight / totalWeight - (communityDegree / totalWeight) ** 2;
  }

  return modularity;
}

export async function detectCommunities(graph: LouvainGraph): Promise<CommunityAssignment> {
  if (graph.nodes.length === 0) {
    return { communities: new Map(), modularity: 0 };
  }

  const adjacency = buildAdjacencyList(graph.edges);
  const totalWeight = [...adjacency.values()].flatMap((n) => [...n.values()]).reduce((sum, w) => sum + w, 0) / 2;

  // Initialize each node to its own community.
  const communities = new Map<string, number>();
  for (const [index, node] of graph.nodes.entries()) {
    communities.set(node, index);
  }

  if (totalWeight === 0) {
    return { communities, modularity: 0 };
  }

  const maxIterations = 10;
  let improvedOverall = true;
  let iteration = 0;

  while (improvedOverall && iteration < maxIterations) {
    improvedOverall = false;
    iteration++;

    for (const node of adjacency.keys()) {
      const currentCommunity = communities.get(node)!;
      const nodeNeighbors = adjacency.get(node) ?? new Map();

      let nodeDegree = 0;
      for (const weight of nodeNeighbors.values()) {
        nodeDegree += weight;
      }

      // Weighted degree sums per community among this node's neighbors.
      const communityWeights = new Map<number, number>();
      for (const [neighbor, weight] of nodeNeighbors) {
        const neighborCommunity = communities.get(neighbor)!;
        communityWeights.set(neighborCommunity, (communityWeights.get(neighborCommunity) ?? 0) + weight);
      }

      let bestCommunity = currentCommunity;
      let bestGain = 0;

      // Pre-compute the total degree of each candidate community.
      for (const [community, edgeWeightToCommunity] of communityWeights) {
        let communityDegree = 0;
        for (const [n, nNeighbors] of adjacency) {
          if (communities.get(n) !== community) continue;
          for (const w of nNeighbors.values()) {
            communityDegree += w;
          }
        }

        const gain = edgeWeightToCommunity / totalWeight - (nodeDegree * communityDegree) / (2 * totalWeight ** 2);

        if (gain > bestGain) {
          bestGain = gain;
          bestCommunity = community;
        }
      }

      if (bestCommunity !== currentCommunity) {
        communities.set(node, bestCommunity);
        improvedOverall = true;
      }
    }

    // Yield the event loop after each Louvain pass so the TUI can
    // process keystrokes and re-render. A single pass over a large
    // graph can take hundreds of milliseconds of synchronous CPU.
    await new Promise((resolve) => { setImmediate(resolve); });
  }

  const modularity = computeModularity(adjacency, communities, totalWeight);
  return { communities, modularity };
}
