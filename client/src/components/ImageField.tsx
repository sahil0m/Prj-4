import { useRef, useState, type DragEvent } from 'react';
import { ImagePlus, Loader2, Trash2, Link2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '../lib/api';
import styles from './ImageField.module.css';

/**
 * Choosing a picture for a slide.
 *
 * This used to be a box asking for a web address, which asked an author to
 * publish their image somewhere else before they could use it. Almost
 * nobody has a URL for the photo on their laptop.
 *
 * Dropping a file, picking one, or pasting an address all end in the same
 * place: an address the slide stores. The server resizes and re-encodes
 * whatever arrives, so a phone photo straight off a camera is fine.
 */
/**
 * The small copy of an uploaded image.
 *
 * Only ours have one; an address someone pasted is left exactly as given.
 */
function thumbOf(url: string): string {
  return /^\/api\/images\/[0-9a-f]{24}$/.test(url) ? `${url}?size=thumb` : url;
}

export function ImageField({
  value,
  onChange,
  label,
  compact = false,
}: {
  value: string;
  onChange: (url: string) => void;
  label: string;
  /** Inside a list row, where there is far less space. */
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [typing, setTyping] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const send = async (file: File | undefined) => {
    if (!file || busy) return;

    setBusy(true);
    try {
      const { url } = await api.uploadImage(file);
      onChange(url);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'That image could not be uploaded. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void send(event.dataTransfer.files[0]);
  };

  if (value !== '' && !typing) {
    return (
      <div className={styles.filled} data-compact={compact}>
        <img className={styles.preview} src={thumbOf(value)} alt="" />

        <div className={styles.filledActions}>
          <button
            type="button"
            className={styles.smallButton}
            onClick={() => {
              input.current?.click();
            }}
            disabled={busy}
          >
            {busy ? <Loader2 size={13} className={styles.spin} /> : <ImagePlus size={13} />}
            Replace
          </button>

          <button
            type="button"
            className={styles.smallButton}
            onClick={() => {
              onChange('');
            }}
            aria-label={`Remove ${label}`}
          >
            <Trash2 size={13} />
            Remove
          </button>
        </div>

        <input
          ref={input}
          type="file"
          accept="image/*"
          className={styles.hidden}
          onChange={(event) => {
            void send(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={styles.drop}
      data-dragging={dragging}
      data-compact={compact}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => {
        setDragging(false);
      }}
      onDrop={onDrop}
    >
      {typing ? (
        <input
          className={styles.urlInput}
          type="url"
          autoFocus
          placeholder="https://example.com/picture.jpg"
          defaultValue={value}
          aria-label={`${label} address`}
          onBlur={(event) => {
            onChange(event.target.value.trim());
            setTyping(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') setTyping(false);
          }}
        />
      ) : (
        <>
          <button
            type="button"
            className={styles.choose}
            onClick={() => {
              input.current?.click();
            }}
            disabled={busy}
          >
            {busy ? <Loader2 size={15} className={styles.spin} /> : <ImagePlus size={15} />}
            {busy ? 'Uploading…' : compact ? 'Add image' : `Upload ${label.toLowerCase()}`}
          </button>

          {!compact && <span className={styles.or}>or drop a file here</span>}

          {/* Still possible to point at an image already on the web. */}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => {
              setTyping(true);
            }}
            title="Use a web address instead"
          >
            <Link2 size={13} />
            Link
          </button>
        </>
      )}

      <input
        ref={input}
        type="file"
        accept="image/*"
        className={styles.hidden}
        onChange={(event) => {
          void send(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
    </div>
  );
}
