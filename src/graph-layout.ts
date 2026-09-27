// ---------------------------------------------------------------------------
// Force layout — a port of the core graph simulation
//
// The core graph runs a d3-force simulation in a worker (`sim.js`) accelerated
// by WebAssembly, with exactly these elements:
//
//   forceX(0).strength(centerStrength)   forceY(0).strength(centerStrength)
//   forceLink().distance(linkDistance).strength(linkStrength * 1/min(degA, degB))
//   forceManyBody().strength(-repelStrength).distanceMin(30)      // theta 0.9
//   forceCollide().radius(60).strength(0.5)
//
//   every tick: all forces with alpha, then v *= 0.6, then x += v
//   alpha starts at 1, decays by 1 - 0.001^(1/300) per tick, stops at 0.001
//   changing the data or the forces reheats the simulation to alpha 0.3
//
// New nodes start at the origin (that is why the core graph spreads out from the
// middle), with a tiny pseudo-random jitter to break the symmetry.
//
// This port keeps the same maths, but works on a bounded subgraph so the cost
// stays O(nodes²) with a few hundred nodes at most — and it stops completely
// once the simulation settles.
// ---------------------------------------------------------------------------

import type { GraphEdge, GraphNode } from './graph-model';
import { SIM_CONSTANTS, type GraphParams } from './graph-params';

const TICKS_PER_FRAME_SMALL = 8;
const TICKS_PER_FRAME_LARGE = 2;

export class GraphLayout {
    readonly x: Float32Array;
    readonly y: Float32Array;
    private readonly vx: Float32Array;
    private readonly vy: Float32Array;
    private readonly degrees: Float32Array;
    private readonly edges: GraphEdge[];
    private params: GraphParams;
    private alpha = 1;
    private random: () => number;

    constructor(
        nodes: GraphNode[],
        edges: GraphEdge[],
        params: GraphParams,
        seed = 1,
    ) {
        const count = Math.max(nodes.length, 1);
        this.x = new Float32Array(count);
        this.y = new Float32Array(count);
        this.vx = new Float32Array(count);
        this.vy = new Float32Array(count);
        this.degrees = new Float32Array(count);
        this.edges = edges;
        this.params = params;
        this.random = createRandom(seed);

        for (const edge of edges) {
            this.degrees[edge.source] = (this.degrees[edge.source] ?? 0) + 1;
            this.degrees[edge.target] = (this.degrees[edge.target] ?? 0) + 1;
        }

        // Core behavior: everything starts at the origin and spreads out.
        for (let index = 0; index < nodes.length; index++) {
            const angle = this.random() * Math.PI * 2;
            const radius = this.random() * 1.5;
            this.x[index] = Math.cos(angle) * radius;
            this.y[index] = Math.sin(angle) * radius;
            this.vx[index] = 0;
            this.vy[index] = 0;
        }
    }

    get nodeCount(): number {
        return this.x.length;
    }


    get frozen(): boolean {
        return this.alpha <= SIM_CONSTANTS.alphaMin;
    }

    setParams(params: GraphParams): void {
        this.params = params;
        this.alpha = Math.max(this.alpha, SIM_CONSTANTS.reheatAlpha);
    }

    /** Reheats the simulation the way the core does when data changes. */
    reheat(alpha = SIM_CONSTANTS.reheatAlpha): void {
        this.alpha = Math.max(this.alpha, alpha);
    }

    moveNode(index: number, x: number, y: number): void {
        if (index < 0 || index >= this.x.length) return;
        this.x[index] = x;
        this.y[index] = y;
        this.vx[index] = 0;
        this.vy[index] = 0;
    }

    /** One simulation step; returns true when anything moved. */
    tick(iterations: number): boolean {
        if (this.alpha <= SIM_CONSTANTS.alphaMin) return false;

        for (let step = 0; step < iterations; step++) {
            if (this.alpha <= SIM_CONSTANTS.alphaMin) break;
            this.applyCenter();
            this.applyLinks();
            this.applyRepulsion();
            this.applyCollide();
            this.integrate();
            this.alpha = this.alpha + (0 - this.alpha) * SIM_CONSTANTS.alphaDecay;
        }
        return true;
    }

    ticksPerFrame(): number {
        return this.x.length > 220 ? TICKS_PER_FRAME_LARGE : TICKS_PER_FRAME_SMALL;
    }

    /** forceX(0) and forceY(0) with the configured strength. */
    private applyCenter(): void {
        const strength = this.params.centerStrength * this.alpha;
        if (strength <= 0) return;
        for (let index = 0; index < this.x.length; index++) {
            this.vx[index] = (this.vx[index] ?? 0) - (this.x[index] ?? 0) * strength;
            this.vy[index] = (this.vy[index] ?? 0) - (this.y[index] ?? 0) * strength;
        }
    }

    /** forceLink: distance from the settings, strength biased by node degree. */
    private applyLinks(): void {
        const distance = Math.max(this.params.linkDistance, 1);
        const strengthScale = this.params.linkStrength * this.alpha;
        if (strengthScale <= 0) return;

        for (const edge of this.edges) {
            const source = edge.source;
            const target = edge.target;
            const sourceDegree = Math.max(this.degrees[source] ?? 1, 1);
            const targetDegree = Math.max(this.degrees[target] ?? 1, 1);
            const bias = sourceDegree / (sourceDegree + targetDegree);
            const strength = strengthScale / Math.min(sourceDegree, targetDegree);

            const dx = (this.x[target] ?? 0) - (this.x[source] ?? 0);
            const dy = (this.y[target] ?? 0) - (this.y[source] ?? 0);
            const current = Math.max(Math.hypot(dx, dy), 0.01);
            const factor = ((current - distance) / current) * strength;

            const fx = dx * factor;
            const fy = dy * factor;
            this.vx[target] = (this.vx[target] ?? 0) - fx * bias;
            this.vy[target] = (this.vy[target] ?? 0) - fy * bias;
            this.vx[source] = (this.vx[source] ?? 0) + fx * (1 - bias);
            this.vy[source] = (this.vy[source] ?? 0) + fy * (1 - bias);
        }
    }

    /**
     * forceManyBody: -repelStrength per pair. The core approximates it with a
     * Barnes-Hut tree; with a few hundred nodes the exact sum is cheap and gives
     * the same result.
     */
    private applyRepulsion(): void {
        const raw = this.params.repelStrength;
        const strength = (Math.abs(raw) < 1 ? -1 : -raw) * this.alpha;
        if (strength === 0) return;

        const distanceMin = SIM_CONSTANTS.distanceMin;
        for (let a = 0; a < this.x.length; a++) {
            const ax = this.x[a] ?? 0;
            const ay = this.y[a] ?? 0;
            for (let b = a + 1; b < this.x.length; b++) {
                let dx = (this.x[b] ?? 0) - ax;
                let dy = (this.y[b] ?? 0) - ay;
                let squared = dx * dx + dy * dy;
                if (squared === 0) {
                    dx = this.random() - 0.5;
                    dy = this.random() - 0.5;
                    squared = dx * dx + dy * dy;
                }
                let current = Math.sqrt(squared);
                if (current < distanceMin) current = Math.sqrt(distanceMin * current);
                current = Math.max(current, 0.01);
                // Negative strength pushes the nodes apart: the force points from
                // each node away from the other one.
                const factor = strength / squared;
                const fx = dx * factor;
                const fy = dy * factor;
                this.vx[a] = (this.vx[a] ?? 0) + fx;
                this.vy[a] = (this.vy[a] ?? 0) + fy;
                this.vx[b] = (this.vx[b] ?? 0) - fx;
                this.vy[b] = (this.vy[b] ?? 0) - fy;
            }
        }
    }

    /**
     * forceCollide: every node carries the core radius of 60, so a pair keeps
     * 120 units between centers. The core measures distances from `x + vx`, and
     * weights the push by the squared radii — with equal radii that is a 50/50
     * split.
     */
    private applyCollide(): void {
        const radius = SIM_CONSTANTS.collideRadius;
        const combine = radius * 2;
        const strength = SIM_CONSTANTS.collideStrength * this.alpha;

        for (let a = 0; a < this.x.length; a++) {
            const ax = (this.x[a] ?? 0) + (this.vx[a] ?? 0);
            const ay = (this.y[a] ?? 0) + (this.vy[a] ?? 0);
            for (let b = a + 1; b < this.x.length; b++) {
                let dx = ax - ((this.x[b] ?? 0) + (this.vx[b] ?? 0));
                let dy = ay - ((this.y[b] ?? 0) + (this.vy[b] ?? 0));
                let squared = dx * dx + dy * dy;
                if (squared >= combine * combine) continue;
                if (squared === 0) {
                    dx = this.random() - 0.5;
                    dy = this.random() - 0.5;
                    squared = dx * dx + dy * dy;
                }
                const current = Math.max(Math.sqrt(squared), 0.01);
                const overlap = ((combine - current) / current) * strength;
                const fx = dx * overlap;
                const fy = dy * overlap;
                this.vx[a] = (this.vx[a] ?? 0) + fx * 0.5;
                this.vy[a] = (this.vy[a] ?? 0) + fy * 0.5;
                this.vx[b] = (this.vx[b] ?? 0) - fx * 0.5;
                this.vy[b] = (this.vy[b] ?? 0) - fy * 0.5;
            }
        }
    }

    /** v *= 0.6, then x += v — the core integration step. */
    private integrate(): void {
        const decay = SIM_CONSTANTS.velocityDecay;
        for (let index = 0; index < this.x.length; index++) {
            const vx = (this.vx[index] ?? 0) * decay;
            const vy = (this.vy[index] ?? 0) * decay;
            this.vx[index] = vx;
            this.vy[index] = vy;
            this.x[index] = (this.x[index] ?? 0) + vx;
            this.y[index] = (this.y[index] ?? 0) + vy;
        }
    }
}

/** Deterministic LCG, the same family the core uses for its fallback simulation. */
function createRandom(seed: number): () => number {
    let state = seed >>> 0 || 1;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}
