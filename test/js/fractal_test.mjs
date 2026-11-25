// Fractal Challenge checker tests - run with: node --test test/js/fractal_test.mjs
//
// Every program here runs through Dojo's real parser and executor.

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { checkLevel, ghostProgram, runDojo } from "../../assets/js/fractal/check.js"

const { levels, commands } = JSON.parse(
    readFileSync(new URL("../../priv/fractal/levels.json", import.meta.url), "utf8"))

const L = (n) => levels[n - 1]
const pass = (n, code) => checkLevel(code, L(n).solution, L(n).tolerance).pass

describe("levels.json", () => {
    test("five levels, each solution runs cleanly in Dojo and draws", () => {
        assert.equal(levels.length, 5)
        for (const lv of levels) {
            const r = runDojo(lv.solution)
            assert.equal(r.error, null, lv.tab)
            assert.ok(r.paths.length > 0, lv.tab)
        }
    })

    test("each solution passes its own level and no other", () => {
        for (const a of levels) {
            for (const b of levels) {
                assert.equal(pass(b.id, a.solution), a.id === b.id, `${a.tab} on ${b.tab}`)
            }
        }
    })

    test("each ghost program draws the solution in the ghost colour", () => {
        for (const lv of levels) {
            const r = runDojo(ghostProgram(lv.solution))
            assert.equal(r.error, null, lv.tab)
            assert.equal(r.paths.length, runDojo(lv.solution).paths.length, lv.tab)
        }
    })

    test("deck commands and their examples exist in Dojo", () => {
        for (const lv of levels) {
            for (const d of lv.deck) assert.ok(commands[d.c], d.c)
        }
        for (const c of Object.values(commands)) {
            assert.equal(runDojo(c.example.replace(/size/g, "20")).error, null, c.example)
        }
    })

    test("copy has no em dashes", () => {
        assert.ok(!readFileSync(new URL("../../priv/fractal/levels.json", import.meta.url), "utf8").includes("\u2014"))
    })
})

describe("triangle", () => {
    test("smaller, turned or left-handed triangles count", () => {
        assert.ok(pass(1, "fw 50\nlt 120\nfw 50\nlt 120\nfw 50"))
        assert.ok(pass(1, "rt 30\nfw 100\nrt 120\nfw 100\nrt 120\nfw 100"))
        assert.ok(pass(1, "loop 3 do\n  fw 70\n  rt 120\nend"))
    })
    test("wrong angle, missing side or a square do not", () => {
        assert.ok(!pass(1, "fw 100\nrt 110\nfw 100\nrt 110\nfw 100"))
        assert.ok(!pass(1, "fw 100\nrt 120\nfw 100"))
        assert.ok(!pass(1, "loop 4 do\n  fw 100\n  rt 90\nend"))
    })
})

describe("hexagon", () => {
    test("any size hexagon counts, a pentagon does not", () => {
        assert.ok(pass(2, "loop 6 do\n  fw 40\n  lt 60\nend"))
        assert.ok(!pass(2, "loop 5 do\n  fw 100\n  rt 72\nend"))
        assert.ok(!pass(2, "loop 6 do\n  fw 100\n  rt 50\nend"))
    })
})

describe("circle", () => {
    test("many small sides count, a hexagon or half circle do not", () => {
        assert.ok(pass(3, "loop 360 do\n  fw 1\n  rt 1\nend"))
        assert.ok(pass(3, "loop 12 do\n  fw 30\n  rt 30\nend"))
        assert.ok(!pass(3, "loop 6 do\n  fw 100\n  rt 60\nend"))
        assert.ok(!pass(3, "loop 18 do\n  fw 10\n  rt 10\nend"))
    })
})

describe("spiral", () => {
    test("same growth at any scale counts, too few turns do not", () => {
        assert.ok(pass(4, "def grow size do\n  fw size\n  rt 90\nend\nloop 1 do\n  grow 10\n  grow 20\n  grow 30\n  grow 40\n  grow 50\n  grow 60\n  grow 70\n  grow 80\nend"))
        assert.ok(!pass(4, "def grow size do\n  fw size\n  rt 90\nend\ngrow 20\ngrow 40\ngrow 60\ngrow 80\ngrow 100\ngrow 120"))
        assert.ok(!pass(4, "loop 4 do\n  fw 100\n  rt 90\nend"))
    })
})

describe("snowflake", () => {
    const snow = (stop, size = 180) => L(5).solution
        .replace("size < 25", `size < ${stop}`)
        .replace("size >= 25", `size >= ${stop}`)
        .replace("edge 180", `edge ${size}`)

    test("same depth at another size counts, and so does one level deeper", () => {
        assert.ok(pass(5, snow(12.5, 90)))
        assert.ok(pass(5, snow(10)))
    })
    test("too shallow or a plain triangle does not", () => {
        assert.ok(!pass(5, snow(61)))
        assert.ok(!pass(5, L(1).solution))
    })
    test("a command that never stops fails fast with a friendly message", () => {
        const t = Date.now()
        const r = checkLevel("def edge size do\n  edge size/3\n  edge size/3\nend\nedge 90", L(5).solution)
        assert.equal(r.status, "error")
        assert.match(r.message, /way to stop/)
        assert.ok(Date.now() - t < 2000)
    })
})

describe("messages", () => {
    test("empty, nothing drawn, and unknown names", () => {
        assert.equal(checkLevel("  ", L(1).solution).status, "empty")
        assert.equal(checkLevel("rt 90", L(1).solution).status, "nothing")
        const r = checkLevel("def grow size do\n  when sise < 3 do\n    fw size\n  end\nend\ngrow 10", L(4).solution)
        assert.equal(r.status, "error")
        assert.match(r.message, /sise/)
    })
})
