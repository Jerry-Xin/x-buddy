// SPDX-License-Identifier: Apache-2.0
interface Node { send: { sendMessage: (c: string) => void }; next?: Node; peers: Node[]; byId: Record<string, Node> }
const local = { sendMessage: (c: string): void => { void c; }, sendTyping: (c: string): void => { void c; } };
export function locals(n: Node, key: string, when: Date, values: Map<string, string>): boolean {
  const view = n as unknown as Record<string, unknown>;
  const { ...rest } = { inner: local, n };
  n.send.sendMessage('c');
  local.sendMessage('c');
  return view[key] !== undefined && Reflect.get(rest, key) !== undefined && Reflect.get(when, key) !== undefined
    && Reflect.get(values, key) !== undefined && String(when).length > 0;
}
