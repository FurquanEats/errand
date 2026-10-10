/** Voice in (browser speech recognition, with server transcription fallback) and voice out (speech synthesis). */

const SR: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

export interface Listening {
  stop: () => void;
}

export function startListening(opts: { onText: (text: string, final: boolean) => void; onEnd: () => void; onError: (msg: string) => void }): Listening {
  if (SR) {
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = (e: any) => {
      let text = '';
      let final = false;
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
        if (e.results[i].isFinal) final = true;
      }
      opts.onText(text, final);
    };
    rec.onerror = (e: any) => opts.onError(e.error === 'not-allowed' ? 'Microphone permission denied' : `Speech error: ${e.error}`);
    rec.onend = opts.onEnd;
    rec.start();
    return { stop: () => rec.stop() };
  }
  // Fallback: record audio and transcribe on the server (needs an OpenAI provider).
  let recorder: MediaRecorder | null = null;
  const chunks: Blob[] = [];
  navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((stream) => {
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const form = new FormData();
        form.append('audio', new Blob(chunks, { type: recorder!.mimeType }), 'speech.webm');
        try {
          const res = await fetch('/api/transcribe', { method: 'POST', body: form, headers: { 'x-errand': '1' } });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          opts.onText(data.text, true);
        } catch (e) {
          opts.onError((e as Error).message);
        }
        opts.onEnd();
      };
      recorder.start();
    })
    .catch(() => {
      opts.onError('Microphone permission denied');
      opts.onEnd();
    });
  return { stop: () => recorder?.state === 'recording' && recorder.stop() };
}

export function speak(text: string) {
  if (!('speechSynthesis' in window)) return;
  const plain = text
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/[*_#>`|]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .slice(0, 1200);
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(plain);
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

export const stopSpeaking = () => 'speechSynthesis' in window && speechSynthesis.cancel();
