import { describe, expect, test } from "bun:test";
import {
  type Agent,
  MIN_TAP_TARGET,
  MOBILE_BREAKPOINT,
  computeScrollToAgent,
  getChatTarget,
  getDisplayAgents,
  isMobile,
  isResizeEnabled,
  meetsTapTarget,
} from "./mobile";

// ── Test data ──

const agents: Agent[] = [
  { id: "owner-1", name: "Sam", role: "owner", status: "idle", hasTmux: true },
  { id: "lead-1", name: "TL", role: "lead", status: "working", hasTmux: true },
  { id: "dev-1", name: "Dev1", role: "dev", status: "idle", hasTmux: true },
  {
    id: "dev-2",
    name: "Dev2",
    role: "dev",
    status: "thinking",
    hasTmux: false,
  },
  { id: "qa-1", name: "QA1", role: "qa", status: "idle", hasTmux: true },
];

// ── isMobile ──

describe("isMobile", () => {
  test("returns true at exactly the breakpoint", () => {
    expect(isMobile(MOBILE_BREAKPOINT)).toBe(true);
  });

  test("returns true below the breakpoint", () => {
    expect(isMobile(375)).toBe(true);
    expect(isMobile(480)).toBe(true);
  });

  test("returns false above the breakpoint", () => {
    expect(isMobile(769)).toBe(false);
    expect(isMobile(1024)).toBe(false);
    expect(isMobile(1920)).toBe(false);
  });

  test("breakpoint is 768", () => {
    expect(MOBILE_BREAKPOINT).toBe(768);
  });
});

// ── getDisplayAgents ──

describe("getDisplayAgents", () => {
  test("on mobile, returns ALL agents including lead/owner", () => {
    const result = getDisplayAgents(agents, true);
    expect(result).toHaveLength(5);
    expect(result.map((a) => a.id)).toContain("owner-1");
    expect(result.map((a) => a.id)).toContain("lead-1");
  });

  test("on desktop, excludes lead and owner agents", () => {
    const result = getDisplayAgents(agents, false);
    expect(result).toHaveLength(3);
    expect(result.map((a) => a.id)).not.toContain("owner-1");
    expect(result.map((a) => a.id)).not.toContain("lead-1");
  });

  test("on desktop, keeps dev/qa/security agents", () => {
    const result = getDisplayAgents(agents, false);
    expect(result.map((a) => a.role)).toEqual(["dev", "dev", "qa"]);
  });

  test("handles empty agent list", () => {
    expect(getDisplayAgents([], true)).toEqual([]);
    expect(getDisplayAgents([], false)).toEqual([]);
  });

  test("handles list with only lead/owner (desktop shows empty)", () => {
    const leadOnly = [agents[0], agents[1]];
    expect(getDisplayAgents(leadOnly, false)).toEqual([]);
    expect(getDisplayAgents(leadOnly, true)).toHaveLength(2);
  });
});

// ── getChatTarget ──

describe("getChatTarget", () => {
  test("on mobile, all agents route to center", () => {
    for (const agent of agents) {
      expect(getChatTarget(agent, true)).toBe("center");
    }
  });

  test("on desktop, lead routes to tl-panel", () => {
    expect(getChatTarget(agents[1], false)).toBe("tl-panel");
  });

  test("on desktop, owner routes to tl-panel", () => {
    expect(getChatTarget(agents[0], false)).toBe("tl-panel");
  });

  test("on desktop, dev/qa/security route to center", () => {
    expect(getChatTarget(agents[2], false)).toBe("center");
    expect(getChatTarget(agents[4], false)).toBe("center");
  });
});

// ── computeScrollToAgent ──

describe("computeScrollToAgent", () => {
  test("returns null when element is fully visible", () => {
    // Container scrolled to 0, width 400. Element at offset 50, width 44.
    const result = computeScrollToAgent(0, 400, 50, 44);
    expect(result).toBeNull();
  });

  test("scrolls left when element is off-screen left", () => {
    // Container scrolled to 200, element at offset 100
    const result = computeScrollToAgent(200, 400, 100, 44);
    expect(result).not.toBeNull();
    expect(result as number).toBeLessThan(200);
    expect(result as number).toBe(92); // 100 - 8 padding
  });

  test("scrolls right when element is off-screen right", () => {
    // Container scrolled to 0, width 300. Element at offset 350, width 44.
    const result = computeScrollToAgent(0, 300, 350, 44);
    expect(result).not.toBeNull();
    expect(result as number).toBeGreaterThan(0);
    expect(result as number).toBe(350 + 44 - 300 + 8); // 102
  });

  test("handles element at the exact right edge (partially visible)", () => {
    // Container: scrollLeft=0, width=300. Element at 280, width=44 → right edge at 324 > 300
    const result = computeScrollToAgent(0, 300, 280, 44);
    expect(result).not.toBeNull();
    expect(result as number).toBe(280 + 44 - 300 + 8); // 32
  });

  test("clamps scroll to zero when element is near start", () => {
    // Container scrolled to 50, element at offset 2, width 44
    const result = computeScrollToAgent(50, 400, 2, 44);
    expect(result).toBe(0); // max(0, 2-8) = 0
  });
});

// ── meetsTapTarget ──

describe("meetsTapTarget", () => {
  test("44px meets the minimum", () => {
    expect(meetsTapTarget(44)).toBe(true);
  });

  test("above 44px meets the minimum", () => {
    expect(meetsTapTarget(48)).toBe(true);
  });

  test("below 44px does not meet the minimum", () => {
    expect(meetsTapTarget(36)).toBe(false);
    expect(meetsTapTarget(43)).toBe(false);
  });

  test("MIN_TAP_TARGET constant is 44", () => {
    expect(MIN_TAP_TARGET).toBe(44);
  });
});

// ── isResizeEnabled ──

describe("isResizeEnabled", () => {
  test("disabled on mobile", () => {
    expect(isResizeEnabled(true)).toBe(false);
  });

  test("enabled on desktop", () => {
    expect(isResizeEnabled(false)).toBe(true);
  });
});
