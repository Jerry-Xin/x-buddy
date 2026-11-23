// SPDX-License-Identifier: Apache-2.0
// Drive the canonical HTTP egress without opening sockets. Existing assertions
// can still observe the decoded payload and the mocked peer's outcome.
export function octoFetch(handlers) {
  return async (input, init) => {
    const url = new URL(input instanceof globalThis.Request ? input.url : input);
    const name = {
      '/v1/bot/sendMessage': 'sendMessage',
      '/v1/bot/typing': 'sendTyping',
      '/v1/bot/readReceipt': 'sendReadReceipt',
    }[url.pathname];
    if (!name) throw new Error(`Unexpected Octo test request: ${url.pathname}`);
    const body = JSON.parse(init.body);
    const token = new globalThis.Headers(init.headers).get('Authorization')?.replace(/^Bearer /, '');
    const response = await handlers[name]?.({
      apiUrl: url.origin,
      botToken: token,
      channelId: body.channel_id,
      channelType: body.channel_type,
      content: body.payload?.content,
      clientMsgNo: body.client_msg_no,
      mentionUids: body.payload?.mention?.uids,
      mentionEntities: body.payload?.mention?.entities,
      mentionAll: body.payload?.mention?.all,
      messageIds: body.message_ids,
      signal: init.signal,
    });
    return Response.json(response ?? {});
  };
}
