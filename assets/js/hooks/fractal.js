// Fractal Challenge course page (/fractal): the Dojo shell's own UI, editor
// (CM6 + PaperLang mode) and turtle, with the course flow on the server.
// The real Command Deck (DojoWeb.DeckLive) writes into the editor through the
// same "writeShell" event and the same terminal/operations.js the shell uses.
//
// Built like the Polygon Lab hook: the editor comes from terminal/extensions.js
// and terminal/view.js without tabs or the shared buffer store, so course code
// never touches a student's Dojo buffers, and turtle hatching is off so
// drawings are not published to the class.
//
// Two ambients are drawn: "ghost" (the level's solution in a faint colour, the
// shape to trace) and "fractal" (the student's code). Each run is checked with
// fractal/check.js, which uses Dojo's parser and executor, and reported to the
// server as { pass, drew, fresh }. All text written here uses textContent.

import { Turtle } from "../turtling/turtle.js"
import { buildExtensions, reapplyCompartments } from "../terminal/extensions.js"
import { createInnerView, getContent, setContent } from "../terminal/view.js"
import { themes } from "../editor/theme.js"
import { temporal } from "../utils/temporal.js"
import { execute as writeToEditor } from "../terminal/operations.js"
import { checkLevel, ghostProgram, runDojo } from "../fractal/check.js"

let cm6 = null

// v2: a square mission was added in front (2026-11-25), so mission numbers
// shifted. A new prefix keeps old saves from loading into the wrong mission.
const STORAGE_PREFIX = "@paperlands.fractal.v2@"
const RUN_DELAY_MS = 650 // code runs by itself shortly after typing stops

const store = {
    load(key) {
        try { return localStorage.getItem(STORAGE_PREFIX + key) } catch { return null }
    },
    save(key, value) {
        try { localStorage.setItem(STORAGE_PREFIX + key, value) } catch { /* private mode */ }
    },
}

const boundsOf = (paths) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of paths) for (const [x, y] of p) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x)
        minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    if (!Number.isFinite(minX)) return null
    return { minX, minY, maxX, maxY }
}
const union = (a, b) => !a ? b : !b ? a : {
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
}

const FractalCourse = {
    async mounted() {
        if (!cm6) cm6 = await import('/vendor/cm6.js?v=6.36')

        const root = this.el
        const canvas = document.getElementById("fx-canvas")
        const textarea = root.querySelector("#fx-editor")
        const statusLine = root.querySelector("#fx-status")
        const statusText = root.querySelector("#fx-status-text")

        const level = { index: 0, solution: "", tolerance: undefined, placeholder: "", ghostBounds: null }
        let lastRan = null

        // --- Turtle (Dojo's real renderer) ---
        const turtle = new Turtle(canvas)
        turtle.hatch = () => {}
        turtle.eagerHatch = () => {}
        turtle._stopHeartbeat()
        const { camera, controls } = turtle.stage
        let userMovedCamera = false
        const onUserCamera = () => { userMovedCamera = true }
        controls.addEventListener("start", onUserCamera)

        // Fit the drawing into the space between the left column and the deck.
        const fitCamera = (b) => {
            if (userMovedCamera || !b) return
            const span = Math.max(150, b.maxX - b.minX, b.maxY - b.minY) * 1.3
            const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2
            const W = window.innerWidth, H = window.innerHeight
            const tanH = Math.tan((camera.fov * Math.PI) / 360)
            const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect()
            const left = rect("#fx-lefthird"), deck = rect("#commanddeck"), card = rect("#fx-mission")
            const deckOpen = deck && deck.width > 0
            let freeL = left ? left.right : 0
            let freeR = deckOpen ? deck.left : W
            let freeT = 40, freeB = card && card.height > 0 ? card.top : H
            if (W < 1024) {
                // Below lg the shell stacks: drawing in the middle column band.
                freeL = left ? Math.min(left.right, W * 0.4) : 0
                freeR = deckOpen ? Math.max(freeL + 120, deck.left) : W
            }
            const fw = Math.max(200, freeR - freeL), fh = Math.max(160, freeB - freeT)
            const distance = Math.max(span / (2 * tanH * (fh / H)), span / (2 * tanH * (fw / H)))
            const unitsPerPx = (2 * distance * tanH) / H
            const tx = cx - ((freeL + freeR) / 2 - W / 2) * unitsPerPx
            const ty = cy + ((freeT + freeB) / 2 - H / 2) * unitsPerPx
            controls.target.set(tx, ty, 0)
            camera.position.set(tx, ty, distance)
            controls.update()
            turtle.requestRender()
        }

        // Status in the nerve HUD's channels: output (good), error, system.
        const CHANNEL = { solved: "nerve-output", error: "nerve-error" }
        const say = (status, message) => {
            statusLine.className = `nerve-hud-status-line ${CHANNEL[status] || "nerve-system"}`
            statusText.textContent = message
        }

        const drawGhost = () => {
            try {
                turtle._localKeys.add("ghost")
                turtle.upsertAmbient("ghost", "target", ghostProgram(level.solution), { hatch: false })
            } catch (err) {
                console.warn("ghost draw failed", err)
            }
        }

        const run = (code, { force = false } = {}) => {
            const result = checkLevel(code, level.solution, level.tolerance ?? undefined)
            try {
                turtle._localKeys.add("fractal")
                turtle.upsertAmbient("fractal", "fractal", code, { hatch: false })
                turtle.focusAmbient("fractal")
            } catch (err) {
                console.warn("turtle draw failed", err)
            }
            const mine = result.drew ? boundsOf(runDojo(code).paths) : null
            fitCamera(union(level.ghostBounds, mine))
            say(result.status, result.status === "empty" ? `ready. ${level.placeholder}` : result.message)
            if (result.status === "empty") return
            const fresh = force || code !== lastRan
            lastRan = code
            this.pushEvent("run", { pass: result.pass, drew: result.drew, fresh })
        }
        const runSoon = temporal.debounce((code) => run(code), RUN_DELAY_MS)

        // --- Editor (Dojo's CM6 setup) ---
        const { extensions, compartments } = buildExtensions(cm6, {
            onDocChange: (content) => {
                store.save(`code${level.index}`, content)
                runSoon(content)
            },
        })
        const runKeymap = cm6.keymap.of([{
            key: "Mod-Enter",
            run: (v) => { userMovedCamera = false; run(getContent(v), { force: true }); return true },
        }])
        const { view } = createInnerView(textarea, cm6, [runKeymap, ...extensions])
        this.view = view
        reapplyCompartments(view, compartments, cm6, "abbott", themes)

        // --- Server events ---
        this.handleEvent("level", ({ index, solution, tolerance, placeholder, starter }) => {
            Object.assign(level, { index, solution, tolerance, placeholder })
            level.ghostBounds = boundsOf(runDojo(solution).paths)
            userMovedCamera = false
            drawGhost()
            setContent(view, store.load(`code${index}`) ?? (starter || ""))
            // Code loaded on opening (starter or saved) is not a new attempt:
            // it earns no xp and does not count as a miss towards hints.
            lastRan = getContent(view)
            run(lastRan)
        })

        // The Command Deck, exactly as in the shell: resolve the card's
        // argument inputs, then write through terminal/operations.js.
        this.handleEvent("writeShell", ({ command, control, args = [] }) => {
            const cmd = command || control
            const resolved = args.map((arg) => {
                if (typeof arg === "number") return arg
                const el = document.getElementById(`cmdparam-${cmd}-${arg}`)
                return el?.value || el?.getAttribute("defaulted") || arg || ""
            }).filter((v) => v !== "?")
            writeToEditor(view, command ? { command, args: resolved, batch: false } : { control, args: resolved }, cm6)
            if (cmd && cmd !== "undo") this.pushEvent("deck", { cmd })
        })

        this.handleEvent("clear-code", () => {
            for (let i = 0; i < 20; i++) {
                try { localStorage.removeItem(`${STORAGE_PREFIX}code${i}`) } catch { /* private mode */ }
            }
        })

        this.handleEvent("save", ({ done, xp }) => {
            store.save("progress", JSON.stringify({ done, xp }))
        })

        this.handleEvent("toast", ({ text }) => say("note", text))

        // Restore progress kept in this browser (the server clamps the numbers).
        let saved = {}
        try { saved = JSON.parse(store.load("progress") || "{}") || {} } catch { saved = {} }
        this.pushEvent("restore", { done: saved.done ?? 0, xp: saved.xp ?? 0 })

        const onResize = temporal.debounce(() => { if (!userMovedCamera) run(getContent(view)) }, 200)
        window.addEventListener("resize", onResize)

        this.cleanup = () => {
            window.removeEventListener("resize", onResize)
            controls.removeEventListener("start", onUserCamera)
            turtle.dispose()
            view.destroy()
        }
    },

    destroyed() {
        this.cleanup?.()
    },
}

export default FractalCourse
