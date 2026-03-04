/**
 * Performs a topological sort on a graph represented by an adjacency list.
 * Uses Kahn's algorithm.
 * 
 * @param nodes An array of all node identifiers (strings).
 * @param adj An adjacency list where adj.get(u) is an array of nodes v such that there is an edge u -> v.
 *            Nodes with no outgoing edges should still be present as keys in the map if they exist in the 'nodes' array, 
 *            potentially mapping to an empty array.
 * @returns An array of node identifiers in topologically sorted order.
 * @throws Error if a cycle is detected in the graph.
 */
export function topologicalSort(nodes: string[], adj: Map<string, string[]>): string[] {
    const inDegree: Map<string, number> = new Map();
    const result: string[] = [];
    const queue: string[] = [];
    const adjReverse: Map<string, string[]> = new Map(); // To easily find incoming edges for in-degree calculation

    // Initialize inDegree for all nodes to 0 and build reverse adjacency list
    nodes.forEach(node => {
        inDegree.set(node, 0);
        adjReverse.set(node, []);
        // Ensure all nodes are in the main adjacency map, even if they have no outgoing edges
        if (!adj.has(node)) {
            adj.set(node, []);
        }
    });

    // Calculate in-degrees and populate reverse adjacency list
    adj.forEach((neighbors, node) => {
        neighbors.forEach(neighbor => {
            // Increment in-degree for the neighbor
            inDegree.set(neighbor, (inDegree.get(neighbor) || 0) + 1);
            // Add edge to reverse adjacency list
            if (!adjReverse.has(neighbor)) adjReverse.set(neighbor, []);
            adjReverse.get(neighbor)!.push(node);
        });
    });

    // Initialize the queue with all nodes that have an in-degree of 0
    inDegree.forEach((degree, node) => {
        if (degree === 0) {
            queue.push(node);
        }
    });

    // Process the queue
    while (queue.length > 0) {
        const u = queue.shift()!; // Non-null assertion because queue.length > 0
        result.push(u);

        // For each neighbor v of u, decrease its in-degree
         if (adj.has(u)) {
            adj.get(u)!.forEach(v => {
                const newDegree = (inDegree.get(v) || 0) - 1;
                inDegree.set(v, newDegree);

                // If in-degree becomes 0, add v to the queue
                if (newDegree === 0) {
                    queue.push(v);
                }
            });
        }
    }

    // Check if a cycle exists
    if (result.length !== nodes.length) {
        // Identify nodes involved in the cycle (nodes with inDegree > 0)
        const cycleNodes = Array.from(inDegree.entries())
                                .filter(([_, degree]) => degree > 0)
                                .map(([node]) => node);
        throw new Error(`Cycle detected in dependencies. Involved nodes might include: ${cycleNodes.join(', ')}`);
    }

    return result;
} 