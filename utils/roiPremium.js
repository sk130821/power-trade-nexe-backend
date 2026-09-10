/** Multi-slot daily trade join by plan tier (101+). Slot share × count = 100% daily Trade. */
const { getRoiPercent } = require('./roiPercent');
const { ROI_LADDER_SLOTS } = require('../config/roiLadder');

const PLAN_SLOT_TIERS = [
  { minAmount: 1001, slots: [0, 6] }, // 1001 — 2 slots × 50%
  { minAmount: 501, slots: [0, 6] },  // 501 — 2 slots × 50%
  { minAmount: 201, slots: [0, 6] },  // 201 — 2 slots × 50%
  { minAmount: 101, slots: [0, 2] },  // 101 — 2 slots × 50%
];

const PREMIUM_PLAN_MIN = 101;

function getPlanSlotConfig(packageAmount) {
  const amount = Number(packageAmount) || 0;
  for (const tier of PLAN_SLOT_TIERS) {
    if (amount >= tier.minAmount) {
      const slots = [...tier.slots];
      return { slots, share: 1 / slots.length, slotCount: slots.length };
    }
  }
  return null;
}

function isPremiumPlan(packageAmount) {
  return getPlanSlotConfig(packageAmount) !== null;
}

function isPremiumJoinSlot(slotIndex, packageAmount) {
  const cfg = getPlanSlotConfig(packageAmount);
  if (!cfg) return false;
  return cfg.slots.includes(Number(slotIndex));
}

/** Gap between the two slots in a plan pair (2 for $101, 6 for $201+). */
function premiumSlotGap(packageAmount) {
  const cfg = getPlanSlotConfig(packageAmount);
  if (!cfg || cfg.slots.length < 2) return 0;
  return cfg.slots[1] - cfg.slots[0];
}

/** Ladder positions consumed by one premium pair (gap 2 → 4-wide blocks: 0,2 | 4,6 | 8,10). */
function premiumSlotBlockSize(packageAmount) {
  const gap = premiumSlotGap(packageAmount);
  if (gap <= 0) return 0;
  return gap === 2 ? 4 : gap + 1;
}

/**
 * Non-overlapping buy slots per income cycle (plan + retopups).
 * $101 (gap 2): L0→[0,2], L1→[4,6], L2→[8,10] — no slot repeats until ladder fills.
 * $201+ (gap 6): L0→[0,6], L1→[1,7], L2→[2,8] … each ladder slot used at most once.
 */
function premiumSlotPairForCycleLevel(cycleLevel, packageAmount) {
  const L = Math.max(0, Number(cycleLevel) || 0);
  const gap = premiumSlotGap(packageAmount);
  if (gap <= 0) return [];

  let base;
  let second;
  if (gap === 2) {
    base = L * 4;
    second = base + 2;
  } else {
    base = L;
    second = L + gap;
  }

  if (base >= ROI_LADDER_SLOTS || second >= ROI_LADDER_SLOTS) return [];
  return [base, second];
}

/** @deprecated use premiumSlotPairForCycleLevel — kept for callers passing slot_index by mistake */
function premiumSlotPairForCycleSlot(cycleSlotIndex, packageAmount) {
  return premiumSlotPairForCycleLevel(cycleSlotIndex, packageAmount);
}

/** All buyable ladder slots from open plan + retopup cycles (unique, no overlap). */
function premiumJoinSlotsForOpenCycles(openCycles, packageAmount) {
  if (!openCycles?.length) return [];
  const set = new Set();
  for (const cycle of openCycles) {
    for (const slot of premiumSlotPairForCycleLevel(cycle.cycle_level, packageAmount)) {
      set.add(slot);
    }
  }
  return [...set].sort((a, b) => a - b);
}

function isPremiumJoinSlotForOpenCycles(slotIndex, packageAmount, openCycles) {
  return premiumJoinSlotsForOpenCycles(openCycles, packageAmount).includes(Number(slotIndex));
}

function openCyclesMatchingPremiumSlot(slotIndex, openCycles, packageAmount) {
  const s = Number(slotIndex);
  return (openCycles || []).filter((cycle) =>
    premiumSlotPairForCycleLevel(cycle.cycle_level, packageAmount).includes(s),
  );
}

function premiumJoinSlots(packageAmount) {
  const cfg = getPlanSlotConfig(packageAmount);
  return cfg ? [...cfg.slots] : [];
}

function premiumSlotRoiShare(packageAmount) {
  const cfg = getPlanSlotConfig(packageAmount);
  return cfg ? cfg.share : null;
}

function computePremiumSlotRoi(packageAmount) {
  const cfg = getPlanSlotConfig(packageAmount);
  if (!cfg) return 0;
  const base = Number(packageAmount) || 0;
  const fullDaily = (base * getRoiPercent(base)) / 100;
  return parseFloat((fullDaily * cfg.share).toFixed(4));
}

function premiumSlotShareLabel(packageAmount) {
  const share = premiumSlotRoiShare(packageAmount);
  if (share == null) return null;
  const pct = Math.round(share * 100);
  return `${pct}%`;
}

module.exports = {
  PREMIUM_PLAN_MIN,
  PLAN_SLOT_TIERS,
  getPlanSlotConfig,
  isPremiumPlan,
  isPremiumJoinSlot,
  premiumSlotGap,
  premiumSlotBlockSize,
  premiumSlotPairForCycleLevel,
  premiumSlotPairForCycleSlot,
  premiumJoinSlotsForOpenCycles,
  isPremiumJoinSlotForOpenCycles,
  openCyclesMatchingPremiumSlot,
  premiumJoinSlots,
  premiumSlotRoiShare,
  premiumSlotShareLabel,
  computePremiumSlotRoi,
};
