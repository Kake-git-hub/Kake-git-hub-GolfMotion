import { useRef, useImperativeHandle, forwardRef } from 'react';

export interface SkeletonCanvasHandle {
  getContext: () => CanvasRenderingContext2D | null;
  clear: () => void;
}

interface SkeletonCanvasProps {
  width: number;
  height: number;
}

/**
 * 骨格描画用の透明 Canvas オーバーレイ
 * 動画の上に重ねてスケルトンを描画する
 */
const SkeletonCanvas = forwardRef<SkeletonCanvasHandle, SkeletonCanvasProps>(
  ({ width, height }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    useImperativeHandle(ref, () => ({
      getContext() {
        return canvasRef.current?.getContext('2d') ?? null;
      },
      clear() {
        const ctx = canvasRef.current?.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, width, height);
        }
      },
    }));

    return (
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="skeleton-canvas"
      />
    );
  },
);

SkeletonCanvas.displayName = 'SkeletonCanvas';

export default SkeletonCanvas;
