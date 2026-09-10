function getRoiPercent(amount) {
  const a = Number(amount) || 0;
  if (a >= 1001) return 0.5;
  if (a >= 101) return 0.4;
  return 0.3;
}

module.exports = { getRoiPercent };
