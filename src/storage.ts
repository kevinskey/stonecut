// Preferences are optional; blocked storage must not prevent the editor opening.
export const safeStorage = {
  getItem(key: string): string | null { try { return localStorage.getItem(key) } catch { return null } },
  setItem(key: string, value: string): void { try { localStorage.setItem(key, value) } catch { /* recovery saving reports its own failures */ } },
  removeItem(key: string): void { try { localStorage.removeItem(key) } catch { /* preference only */ } },
}
