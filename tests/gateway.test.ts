import { describe, expect, it } from "vitest"
import { fetchDailyUsage } from "../src/gateway.js"

describe("daily usage", () => {
  it("converts Cline's micro-USD cost field into dollars", async () => {
    const fetchImpl: typeof fetch = async (url) => {
      expect(String(url)).toContain("/usages/daily")
      return Response.json({
        success: true,
        data: {
          items: [
            {
              date: "2026-10-18",
              aiModelName: "cline-pass/glm-5.3-flash",
              promptTokens: 42,
              completionTokens: 330,
              costUsd: 17130,
            },
          ],
        },
      })
    }
    const result = await fetchDailyUsage({
      baseURL: "https://api.example/api/v1",
      apiKey: "sk_test",
      userId: "usr_test",
      fetchImpl,
    })
    expect(result.ok).toBe(true)
    expect(result.rows[0]).toMatchObject({
      date: "2026-10-18",
      model: "cline-pass/glm-5.3-flash",
      tokens: 372,
    })
    expect(result.rows[0]?.costUsd).toBeCloseTo(0.01713, 8)
  })
})
