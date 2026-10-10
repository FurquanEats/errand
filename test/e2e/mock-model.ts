/**
 * A scripted, OpenAI-compatible model for end-to-end tests. It makes the same tool calls a real
 * model would for a handful of known requests, so the whole stack (chat runs, tools, the browser
 * agent, approvals, codes) can be exercised without an API key. It also serves a tiny test shop.
 */
import http from 'node:http';

type Out = { text?: string; tool?: { name: string; args: unknown } };
const call = (name: string, args: unknown): Out => ({ tool: { name, args } });
const text = (t: string): Out => ({ text: t });

const textOf = (content: any): string => (typeof content === 'string' ? content : (content ?? []).map((p: any) => p.text ?? '').join('\n'));

const SHOP = `<!doctype html><html><head><title>Test Shop</title></head><body style="font-family:sans-serif;padding:40px">
<h1>Test Shop</h1><label for=q>Search</label> <input id=q name=q placeholder="Search products">
<button onclick="document.getElementById('r').textContent='Found: Blue Mug $12'">Search</button>
<p id=r></p><label for=pw>Password</label> <input id=pw type=password name=password>
<button onclick="document.body.insertAdjacentHTML('beforeend','<h2>Order confirmed #A123</h2>')">Place order</button></body></html>`;

// An application form: a file field for the CV and a big text box you can click while you're in control.
const FORM = `<!doctype html><html><head><title>Apply</title></head><body style="font-family:sans-serif;margin:0">
<label for=cv>CV</label> <input id=cv type=file onchange="document.getElementById('o').textContent='File: '+this.files[0].name">
<p id=o></p><p id=o2></p>
<textarea id=t aria-label="Cover letter" style="position:fixed;left:0;top:50%;width:100%;height:45%" oninput="document.getElementById('o2').textContent='Typed: '+this.value"></textarea>
</body></html>`;

/** What a model would pull out of the e2e inbox, keyed by each email's id. */
function classifyMail(prompt: string) {
  return prompt.split(/\n\n(?=\[)/).map((block) => {
    const id = block.match(/^\[([^\]]+)\]/)?.[1] ?? '';
    const subject = block.match(/Subject: (.*?) \| Looks like/)?.[1] ?? '';
    const date = block.match(/\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/g)?.[1] ?? '';
    const item = (o: object) => ({ id, amount: '', date: '', ref: '', note: '', title: '', ...o });
    if (/applying to (\w+)/.test(subject))
      return item({ kind: 'job', status: 'received', name: subject.match(/applying to (\w+)/)![1], title: 'Product Engineer' });
    if (/interview/i.test(subject))
      return item({ kind: 'job', status: 'interview', name: subject.split(':')[0], date: new Date(Date.now() + 86400_000).toISOString() });
    if (/order .*shipped/i.test(subject)) return item({ kind: 'order', status: 'shipped', name: 'Amazon', title: 'Wireless earbuds', ref: '407-1234567' });
    if (/Airtel bill/.test(subject)) return item({ kind: 'bill', status: 'due', name: 'Airtel', amount: '₹799', date });
    if (/IndiGo booking/.test(subject)) return item({ kind: 'travel', status: 'booked', name: 'IndiGo', title: '6E 512 Hyderabad → Goa', date, ref: 'ABC123' });
    if (/expense report/.test(subject)) return item({ kind: 'todo', status: 'open', name: 'Expensify', title: 'Approve Priya’s expense report', date });
    return item({ kind: 'ignore', status: '', name: '' });
  });
}

function decide(body: any, port: number): Out {
  const tools: string[] = (body.tools ?? []).map((t: any) => t.function.name);
  const msgs: any[] = body.messages ?? [];
  const sys = textOf(msgs.find((m) => m.role === 'system')?.content);
  const last = msgs[msgs.length - 1];
  const lastText = textOf(last?.content);

  // The browser agent: one action per turn, driven by how many steps have happened.
  if (tools.includes('done') && tools.includes('click')) {
    const n = (lastText.match(/Recent actions:\n([\s\S]*?)\n\n/)?.[1] ?? '').split('\n').filter((l) => /^\d+\./.test(l)).length;
    const el = (re: RegExp) => Number((lastText.split('\n').find((l) => re.test(l)) ?? '').match(/\[(\d+)\]/)?.[1] ?? 1);
    const vaultToken = sys.match(/\{\{vault:[a-f0-9]{8}\.password\}\}/)?.[0];
    if (/TASK:.*TAKEOVER/.test(sys)) {
      if (n === 0) return call('navigate', { url: `http://localhost:${port}/form` });
      if (n === 1) return call('upload', { id: el(/type=file/), file: 'cv.pdf' });
      if (!/handed it back/.test(lastText)) return call('wait', { seconds: 1 });
      const found = [lastText.match(/File: \S+/)?.[0], lastText.match(/Typed: \w+/)?.[0]].filter(Boolean).join(', ');
      return call('done', { success: true, result: found || 'nothing on the page' });
    }
    if (/TASK:.*OTP/.test(sys)) {
      if (n === 0) return call('navigate', { url: `http://localhost:${port}/shop` });
      if (n === 1) return call('get_verification', { site: 'testshop.com', kind: 'code' });
      const code = lastText.match(/Verification: (\S+)/)?.[1] ?? 'none';
      return call('done', { success: code !== 'none', result: `Logged in with code ${code}` });
    }
    if (n === 0) return call('navigate', { url: `http://localhost:${port}/shop` });
    if (n === 1) return call('type', { id: el(/placeholder="Search products"/), text: 'blue mug' });
    if (n === 2) return call('click', { id: el(/<button>.*"Search"/) });
    if (n === 3 && vaultToken) return call('type', { id: el(/type=password/), text: vaultToken });
    if (n <= 4) return call('note', { text: lastText.match(/Found: [^\n]+/)?.[0] ?? 'no result' });
    if (n === 5) return call('click', { id: el(/"Place order"/) });
    return call('done', { success: /Order confirmed/.test(lastText), result: lastText.match(/Order confirmed #\w+/)?.[0] ?? 'Could not confirm' });
  }

  // The main assistant.
  if (tools.includes('handoff')) {
    const users = msgs.filter((m) => m.role === 'user');
    const u = textOf(users[users.length - 1]?.content).toLowerCase();
    // Two-step chat controls: list first, then act on the id it returned.
    const listed = last.role === 'tool' && /^\[/.test(textOf(last.content)) ? JSON.parse(textOf(last.content)) : null;
    if (listed?.[0]?.id && u.includes('pause')) return call('routine_update', { id: listed[0].id, enabled: false });
    if (listed?.[0]?.id && u.includes('already paid')) return call('action_button_update', { id: listed[0].id, status: 'done' });
    if (listed?.[0]?.id && u.includes('panel')) return call('panel_update', { id: listed[0].id, size: 'lg' });
    if (last.role === 'tool') return text(`All done. ${textOf(last.content).slice(0, 300)}`);
    if (u.includes('pause')) return call('routine_list', {});
    if (u.includes('remind me to pay')) return call('action_button_create', { title: 'Pay the electricity bill', prompt: 'Pay my electricity bill' });
    if (u.includes('already paid')) return call('action_button_update', {});
    if (u.includes('panel bigger')) return call('panel_list', {});
    if (u.includes('use mock-1-mini')) return call('model_choose', { model: 'mock-1-mini' });
    if (u.includes('how i do returns'))
      return call('specialty_save', {
        name: 'Product returns',
        when: 'returning an online order',
        steps: ['Ask for a refund, not store credit', 'Print the label and email it to me'],
      });
    if (u.includes('otp')) return call('handoff', { goal: 'Log into the test shop with OTP' });
    if (u.includes('order')) return call('handoff', { goal: 'Search the test shop for a blue mug, log in, and place the order' });
    if (u.includes('presentation'))
      return call('make_presentation', {
        title: 'Usage report',
        slides: [
          { title: 'Two months with Errand', subtitle: 'Your usage' },
          { title: 'Messages', stat: { value: '128', label: 'messages sent' } },
          { title: 'Browser tasks per week', chart: { type: 'bar', labels: ['W1', 'W2', 'W3', 'W4'], values: [3, 5, 8, 6] } },
        ],
      });
    if (u.includes('connect') && u.includes('gmail')) return call('connect_account', { service: 'google', site: 'work@example.com' });
    if (u.includes('every morning')) return call('routine_create', { title: 'Morning brief', prompt: 'Brief me on my day', kind: 'daily', time: '08:00' });
    if (u.includes('moved to')) return call('settings_update', { location: 'Denver' });
    if (u.includes('what version')) return call('app_about', {});
    if (u.includes('remember')) return call('memory_save', { content: 'Favourite colour is blue', category: 'preferences' });
    return text('Hello from the test model.');
  }

  // Background jobs.
  if (/You read emails for Errand/.test(sys)) return text(JSON.stringify({ items: classifyMail(lastText) }));
  if (tools.includes('fetch_url')) return text('{"value": 42, "label": "Answer"}');
  if (/title for a conversation/i.test(lastText)) return text('Test chat');
  if (/long-term memory/i.test(sys)) return text('{"add":[],"update":[],"remove":[]}');
  if (/proactive brain/i.test(sys))
    return text('{"actions":[{"title":"Order a test mug","description":"From the test shop","prompt":"please order a test mug","icon":"☕","priority":1}]}');
  if (/home-screen panels/i.test(sys))
    return text(
      JSON.stringify({
        title: 'The Answer',
        data_prompt: 'Return {"value":42}',
        html: '<b id=v></b><script>v.textContent=PANEL_DATA.value</script>',
        refresh_minutes: 60,
        size: 'sm',
      }),
    );
  if (/Reply with just the word/i.test(lastText)) return text('ready');
  return text('ok');
}

function respond(res: http.ServerResponse, body: any, out: Out) {
  const id = `chatcmpl-${Math.random().toString(36).slice(2)}`;
  const created = Math.floor(Date.now() / 1000);
  const toolCall = out.tool && {
    id: `call_${Math.random().toString(36).slice(2, 10)}`,
    type: 'function',
    function: { name: out.tool.name, arguments: JSON.stringify(out.tool.args) },
  };
  const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: out.text ?? null, tool_calls: toolCall ? [toolCall] : undefined },
            finish_reason: toolCall ? 'tool_calls' : 'stop',
          },
        ],
        usage,
      }),
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (delta: unknown, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    );
  send({ role: 'assistant' });
  for (const w of out.text?.match(/\S+\s*/g) ?? []) send({ content: w });
  if (toolCall) send({ tool_calls: [{ index: 0, ...toolCall }] });
  send({}, toolCall ? 'tool_calls' : 'stop');
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage })}\n\n`);
  res.end('data: [DONE]\n\n');
}

export function startMockModel(port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.url === '/shop') return void res.writeHead(200, { 'content-type': 'text/html' }).end(SHOP);
    if (req.url === '/form') return void res.writeHead(200, { 'content-type': 'text/html' }).end(FORM);
    if (req.url?.endsWith('/models'))
      return void res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ data: [{ id: 'mock-1' }, { id: 'mock-embedding-1' }, { id: 'mock-1-mini' }] }));
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        const body = JSON.parse(raw || '{}');
        // A model that is always overloaded, for testing automatic fallback.
        if (body.model === 'mock-busy')
          return void res
            .writeHead(503, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: { message: 'The model is overloaded. Please try again later.', type: 'server_error' } }));
        respond(res, body, decide(body, port));
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
