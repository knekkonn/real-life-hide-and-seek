export function normalizeRoom(room) {
  if (!room) return null;
  for (const key of ['players','itemBoxes','traps','decoys','effects']) room[key] ||= {};
  room.eventLog ||= [];
  for (const player of Object.values(room.players)) {
    player.inventory ||= [];
    player.effects ||= {};
  }
  return room;
}

export async function transactRoom(api, reference, mutator) {
  const result = await api.runTransaction(reference, (current) => {
    // null may be only an empty local cache. A no-op null write lets the
    // server compare and retry with its existing room; undefined aborts locally.
    if (current == null) return null;
    return mutator(normalizeRoom(current)) ?? undefined;
  }, {applyLocally:false});
  return result.committed ? normalizeRoom(result.snapshot.val()) : null;
}
