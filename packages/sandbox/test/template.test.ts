import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import * as Template from "../src/Template.ts"

describe("Template.TemplateName", () => {
  it("takes up to 30 letters, digits, `-`, and `_`, starting with a letter or digit", () => {
    const isTemplateName = Schema.is(Template.TemplateName)

    expect(isTemplateName("opencode")).toBe(true)
    expect(isTemplateName("claude_code-2")).toBe(true)
    expect(isTemplateName("a".repeat(30))).toBe(true)
    expect(isTemplateName("a".repeat(31))).toBe(false)
    expect(isTemplateName("opencode-1.18")).toBe(false)
    expect(isTemplateName("-opencode")).toBe(false)
    expect(isTemplateName("")).toBe(false)
  })
})
