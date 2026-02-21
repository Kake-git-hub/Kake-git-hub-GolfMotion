/**
 * Canvas 上にグリッドを描画する
 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  divisions: number = 8,
): void {
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;

  const stepX = width / divisions;
  const stepY = height / divisions;

  // 縦線
  for (let i = 1; i < divisions; i++) {
    const x = Math.round(stepX * i) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  // 横線
  for (let i = 1; i < divisions; i++) {
    const y = Math.round(stepY * i) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // 中心線（やや太め）
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.lineWidth = 1.5;

  const cx = Math.round(width / 2) + 0.5;
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, height);
  ctx.stroke();

  const cy = Math.round(height / 2) + 0.5;
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(width, cy);
  ctx.stroke();
}
