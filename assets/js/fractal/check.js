// Fractal Challenge checker.
//
// Runs a program through Dojo's own PaperLang parser and executor (the same
// code the turtle uses), collects the drawn paths, and compares them with the
// level's reference solution, also run through Dojo. The comparison ignores
// where the drawing is, how big it is, which way it is turned and whether it
// is mirrored, so `fw 50` triangles and `lt 120` triangles both count.
//
// Ported from fractal-challenge/levels.js (checkOps). The normalisation is
// centroid + RMS radius instead of a bounding box, so it is rotation-safe.

import { parseProgram } from "../turtling/parse.js"
import { drainEvents } from "../turtling/executor.js"
import { Parser } from "../turtling/mafs/parse.js"
import { Evaluator } from "../turtling/mafs/evaluate.js"

// Small limits for the checker only, so a runaway recursion fails fast
// with a friendly message instead of freezing the tab.
export const LIMITS = { maxCommands: 30_000, maxRecurses: 20_000, maxRecurseDepth: 60 }
export const SAMPLES = 160
export const TOLERANCE = 0.08
const ANGLE_STEP = 5

// The faint target shape: the level's solution, turtle hidden, in a dim
// warm colour. The colour must be quoted or Dojo reads it as maths.
export const GHOST_COLOUR = "8a5c3c"
export const ghostProgram = (solution) => `hide\nbeColour '${GHOST_COLOUR}'\n${solution}`

// Run code with Dojo's engine. Returns { paths: [[[x,y],...],...], error }.
export function runDojo(code) {
    let ast
    try {
        ast = parseProgram(code)
    } catch (err) {
        return { paths: [], error: friendly(err) }
    }
    const paths = []
    try {
        const deps = { mathParser: new Parser(), mathEvaluator: new Evaluator() }
        for (const ev of drainEvents(ast, deps, LIMITS)) {
            if (ev.type === "path" && ev.points?.length > 1) {
                paths.push(ev.points.map(([x, y]) => [x, y]))
            }
        }
        return { paths, error: null }
    } catch (err) {
        return { paths, error: friendly(err) }
    }
}

function friendly(err) {
    const msg = String(err?.message || err)
    if (/limit/i.test(msg)) {
        return "The turtle took too many steps. If your command calls itself, does it have a way to stop?"
    }
    if (/Undefined variable: (\w+)/.test(msg)) {
        const name = msg.match(/Undefined variable: (\w+)/)[1]
        return `Dojo doesn't know "${name}" here. Is it an input of your def?`
    }
    if (/Expected 'do'/.test(msg)) return "A loop, def or when line has to end with do."
    return msg.endsWith(".") ? msg : msg + "."
}

// Points spread evenly along all drawn lines, by length.
export function samplePaths(paths, n = SAMPLES) {
    const segs = []
    for (const p of paths) {
        for (let i = 1; i < p.length; i++) {
            const [x0, y0] = p[i - 1], [x1, y1] = p[i]
            const len = Math.hypot(x1 - x0, y1 - y0)
            if (len > 1e-9) segs.push({ x0, y0, x1, y1, len })
        }
    }
    const total = segs.reduce((s, g) => s + g.len, 0)
    if (!segs.length || total < 1e-6) return []
    const step = total / n
    const pts = []
    let acc = 0, next = 0
    for (const s of segs) {
        while (next <= acc + s.len + 1e-9 && pts.length < n + 1) {
            const t = (next - acc) / s.len
            pts.push([s.x0 + (s.x1 - s.x0) * t, s.y0 + (s.y1 - s.y0) * t])
            next += step
        }
        acc += s.len
    }
    return pts
}

// Centre on the centroid, scale to unit RMS radius.
export function normalise(pts) {
    const n = pts.length
    const cx = pts.reduce((s, p) => s + p[0], 0) / n
    const cy = pts.reduce((s, p) => s + p[1], 0) / n
    const r = Math.sqrt(pts.reduce((s, p) => s + (p[0] - cx) ** 2 + (p[1] - cy) ** 2, 0) / n) || 1
    return pts.map(([x, y]) => [(x - cx) / r, (y - cy) / r])
}

function directed(A, B) {
    let worst = 0
    for (const a of A) {
        let best = Infinity
        for (const b of B) {
            const d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
            if (d < best) best = d
        }
        if (best > worst) worst = best
    }
    return Math.sqrt(worst)
}

const hausdorff = (A, B) => Math.max(directed(A, B), directed(B, A))

const rotate = (pts, deg) => {
    const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180)
    return pts.map(([x, y]) => [x * c - y * s, x * s + y * c])
}

// Best match score between two sets of drawn paths (lower is closer).
export function shapeDistance(minePaths, targetPaths) {
    const mine = samplePaths(minePaths)
    const tgt = samplePaths(targetPaths)
    if (!mine.length || !tgt.length) return Infinity
    const M = normalise(mine)
    const T = normalise(tgt)
    const mirrored = T.map(([x, y]) => [x, -y])
    let best = Infinity
    for (const base of [T, mirrored]) {
        for (let a = 0; a < 360; a += ANGLE_STEP) {
            const d = hausdorff(M, rotate(base, a))
            if (d < best) best = d
        }
    }
    return best
}

const targetCache = new Map()
function targetPaths(solution) {
    if (!targetCache.has(solution)) targetCache.set(solution, runDojo(solution).paths)
    return targetCache.get(solution)
}

// What the page needs after a run:
// { status: "empty" | "error" | "nothing" | "close" | "solved", drew, pass, message, score }
export function checkLevel(code, solution, tolerance = TOLERANCE) {
    if (!code.trim()) {
        return { status: "empty", drew: false, pass: false, message: "ready", score: Infinity }
    }
    const { paths, error } = runDojo(code)
    if (error) return { status: "error", drew: paths.length > 0, pass: false, message: error, score: Infinity }
    if (!paths.length) {
        return { status: "nothing", drew: false, pass: false, message: "The turtle didn't draw anything. Try a fw first.", score: Infinity }
    }
    const score = shapeDistance(paths, targetPaths(solution))
    const pass = score <= tolerance
    return {
        status: pass ? "solved" : "close",
        drew: true,
        pass,
        score,
        message: pass ? "That matches the faint shape." : "Not quite. Compare your lines to the faint shape.",
    }
}
