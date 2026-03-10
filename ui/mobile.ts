/**
 * Mobile-specific JS logic for Agent Office UI.
 * Extracted as a module for testability — inlined into index.html at build.
 */

export const MOBILE_BREAKPOINT = 768;

/** Returns true if viewport width is at or below mobile breakpoint */
export function isMobile(viewportWidth?: number): boolean {
  const w = viewportWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 1024);
  return w <= MOBILE_BREAKPOINT;
}

export interface Agent {
  id: string;
  name?: string;
  role: string;
  status?: string;
  hasTmux?: boolean;
}

/**
 * On mobile, TL/owner agents should appear in the main agent list
 * so they show up in the horizontal top bar.
 * On desktop, they are excluded (shown in the right TL panel instead).
 */
export function getDisplayAgents(agents: Agent[], mobile: boolean): Agent[] {
  if (mobile) {
    // All agents shown — TL/owner included in the list
    return agents;
  }
  // Desktop: filter out lead/owner (they appear in the right panel)
  return agents.filter(a => a.role !== 'lead' && a.role !== 'owner');
}

/**
 * Determines if a given agent should route to the TL panel (right side)
 * or to the center chat panel.
 * On mobile: always center (TL panel is hidden).
 * On desktop: lead/owner → TL panel, others → center.
 */
export function getChatTarget(agent: Agent, mobile: boolean): 'center' | 'tl-panel' {
  if (mobile) return 'center';
  if (agent.role === 'lead' || agent.role === 'owner') return 'tl-panel';
  return 'center';
}

/**
 * Computes the scroll offset needed to bring an avatar element
 * into view within a horizontally scrolling container.
 * Returns the target scrollLeft value, or null if already visible.
 */
export function computeScrollToAgent(
  containerScrollLeft: number,
  containerWidth: number,
  elementOffsetLeft: number,
  elementWidth: number,
): number | null {
  const elRight = elementOffsetLeft + elementWidth;
  const visibleLeft = containerScrollLeft;
  const visibleRight = containerScrollLeft + containerWidth;

  // Already fully visible
  if (elementOffsetLeft >= visibleLeft && elRight <= visibleRight) {
    return null;
  }

  // Element is to the left of visible area — scroll left
  if (elementOffsetLeft < visibleLeft) {
    return Math.max(0, elementOffsetLeft - 8); // 8px padding
  }

  // Element is to the right of visible area — scroll right
  return elRight - containerWidth + 8;
}

/**
 * Touch-friendly minimum tap target size (in px).
 * Per Apple HIG and Material Design guidelines.
 */
export const MIN_TAP_TARGET = 44;

/**
 * Checks if a dimension meets the minimum tap target requirement.
 */
export function meetsTapTarget(size: number): boolean {
  return size >= MIN_TAP_TARGET;
}

/**
 * Determines if the right panel resize handler should be active.
 * Disabled on mobile since the right panel is hidden.
 */
export function isResizeEnabled(mobile: boolean): boolean {
  return !mobile;
}
