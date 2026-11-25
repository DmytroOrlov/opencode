/**
 * Trusted backing-store identity. The identity is owned by a filesystem provider,
 * not a wrapper, a pathname, or a config leaf inode. Transparent wrappers preserve
 * the enumerable symbol property when they spread their delegate.
 */
export const backingNamespace = Symbol("opencode.filesystem.backingNamespace")

/** One stable identity for all acquisitions of the actual local OS filesystem. */
export const localBackingNamespace: object = Object.freeze({})

type WithBackingNamespace = { readonly [backingNamespace]?: object }

export function namespaceOf(value: object): object | undefined {
  return (value as WithBackingNamespace)[backingNamespace]
}

export function withNamespace<T extends object>(value: T, namespace: object): T & WithBackingNamespace {
  // Object-literal symbol fields are enumerable; FSUtil.layer and the real
  // delegate recorder both use object spread, so they preserve the capability.
  return { ...value, [backingNamespace]: namespace }
}
