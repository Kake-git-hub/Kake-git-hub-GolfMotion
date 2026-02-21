import { useCallback, useRef, type ChangeEvent } from 'react';

interface VideoUploaderProps {
  onVideoSelected: (file: File) => void;
  disabled?: boolean;
}

/**
 * 動画ファイルのアップロード UI
 * ドラッグ＆ドロップとファイル選択に対応
 */
export default function VideoUploader({ onVideoSelected, disabled }: VideoUploaderProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dropRef = useRef<HTMLDivElement | null>(null);

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) onVideoSelected(file);
    },
    [onVideoSelected],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dropRef.current?.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('video/')) {
        onVideoSelected(file);
      }
    },
    [onVideoSelected],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dropRef.current?.classList.add('drag-over');
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dropRef.current?.classList.remove('drag-over');
  }, []);

  return (
    <div
      ref={dropRef}
      className={`upload-zone ${disabled ? 'disabled' : ''}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onClick={() => !disabled && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/*"
        onChange={handleChange}
        style={{ display: 'none' }}
        disabled={disabled}
      />
      <div className="upload-icon">🏌️</div>
      <p className="upload-text">
        ゴルフスイング動画をドロップ<br />
        またはクリックして選択
      </p>
      <p className="upload-hint">MP4 推奨</p>
    </div>
  );
}
