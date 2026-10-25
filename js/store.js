let browserStore = null;
export function configureStore(store) { browserStore = store; }
export function remoteAction(action, args) { return browserStore?.action?.(action,args) || null; }
export function mutateRoom(code, mutator) {
  // Server actions operate on a request-local snapshot; the Worker commits via CAS.
  if (typeof code === 'object' && code !== null && 'room' in code) {
    const result = mutator(code.room);
    if (result) code.room = result;
    return Promise.resolve(result);
  }
  if (!browserStore) throw new Error('Backend nicht initialisiert.');
  return browserStore.mutate(code, mutator);
}
