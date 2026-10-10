import { useEffect, useRef, useState } from 'react';
import { fileToAttachment } from '../api';
import { startListening, type Listening } from '../voice';
import { Icon } from './Icon';

export interface Attachment {
  name: string;
  mediaType: string;
  data: string;
}

export function Composer(props: {
  /** Return false when sending failed, to put the text and files back. */
  onSend: (text: string, attachments: Attachment[]) => void | boolean | Promise<void | boolean>;
  onStop?: () => void;
  busy?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  initial?: string;
  /** Hands-free conversation: listen, reply out loud, listen again. */
  voiceMode?: boolean;
  onToggleVoice?: () => void;
}) {
  const [text, setText] = useState(props.initial ?? '');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [listening, setListening] = useState<Listening | null>(null);
  const [error, setError] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(220, el.scrollHeight) + 'px';
  }, [text]);

  useEffect(() => {
    if (props.autoFocus) ta.current?.focus();
  }, [props.autoFocus]);

  const send = async () => {
    const t = text.trim();
    if ((!t && !files.length) || props.busy) return;
    const sent = files;
    setText('');
    setFiles([]);
    if ((await props.onSend(t, sent)) === false) {
      setText((cur) => cur || t);
      setFiles((cur) => (cur.length ? cur : sent));
    }
  };

  const addFiles = async (list: FileList | File[]) => {
    const next: Attachment[] = [];
    for (const f of Array.from(list)) {
      if (f.size > 15 * 1024 * 1024) {
        setError(`${f.name} is larger than 15 MB`);
        continue;
      }
      next.push(await fileToAttachment(f));
    }
    setFiles((cur) => [...cur, ...next]);
  };

  const toggleMic = () => {
    if (listening) {
      listening.stop();
      return;
    }
    setError('');
    const base = text ? text + ' ' : '';
    const l = startListening({
      onText: (t) => setText(base + t),
      onEnd: () => setListening(null),
      onError: (m) => setError(m),
    });
    setListening(l);
  };

  return (
    <div
      className="composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
      }}
    >
      {files.length > 0 && (
        <div className="attachments">
          {files.map((f, i) => (
            <div key={i} className="attachment">
              {f.mediaType.startsWith('image/') ? <img src={`data:${f.mediaType};base64,${f.data}`} alt="" /> : <Icon name="clip" size={14} />}
              <span>{f.name}</span>
              <button onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label="Remove">
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        rows={1}
        value={text}
        placeholder={props.placeholder ?? 'Ask Errand to do anything…'}
        aria-label="Message"
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const imgs = Array.from(e.clipboardData.files);
          if (imgs.length) {
            e.preventDefault();
            void addFiles(imgs);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="controls">
        <button className="round" title="Attach files or photos" aria-label="Attach files or photos" onClick={() => fileInput.current?.click()}>
          <Icon name="clip" />
        </button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files).then(() => (e.target.value = ''))} />
        <button
          className={`round ${listening ? 'rec' : ''}`}
          title={listening ? 'Stop listening' : 'Speak'}
          aria-label={listening ? 'Stop listening' : 'Speak'}
          aria-pressed={!!listening}
          onClick={toggleMic}
        >
          <Icon name="mic" />
        </button>
        {error && (
          <span className="err" role="alert">
            {error}
          </span>
        )}
        <div className="spacer" />
        {props.onToggleVoice && (
          <button
            className={`round ${props.voiceMode ? 'rec' : ''}`}
            title={props.voiceMode ? 'End voice conversation' : 'Talk hands-free'}
            aria-label={props.voiceMode ? 'End voice conversation' : 'Talk hands-free'}
            aria-pressed={!!props.voiceMode}
            onClick={props.onToggleVoice}
          >
            <Icon name="speaker" />
          </button>
        )}
        {props.busy && props.onStop ? (
          <button className="round send" title="Stop" aria-label="Stop" onClick={props.onStop}>
            <Icon name="stop" />
          </button>
        ) : (
          <button className="round send" title="Send (Enter)" aria-label="Send" disabled={!text.trim() && !files.length} onClick={send}>
            <Icon name="arrowUp" stroke={2.4} />
          </button>
        )}
      </div>
    </div>
  );
}
