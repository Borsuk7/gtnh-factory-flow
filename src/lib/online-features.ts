/** Read by the browser bundle and server. Next.js inlines the public flag at build time. */
export function areOnlineFeaturesEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ENABLE_ONLINE_FEATURES?.trim().toLowerCase() !== "false";
}
