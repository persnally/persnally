import { useState } from "preact/hooks";
import type { PersnallyClient } from "../../api/client";
import type { Profile } from "../../api/types";
import type { Boot } from "../../lib/boot-state";
import { usePoll } from "../../lib/use-poll";
import { AskComposer } from "./AskComposer";
import { Portrait } from "./Portrait";

/** Mirror — "what does it know about me?" Portrait front and center, the ask
    composer above it: the two things only Persnally can show. */
export function MirrorView({ client, boot }: { client: PersnallyClient; boot: Boot }) {
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined); // undefined = loading

  usePoll(boot, async () => {
    setProfile(await client.profile());
  });

  return (
    <div class="canvas-col">
      <AskComposer client={client} />
      {profile === undefined && <div class="card empty reveal">loading…</div>}
      {profile === null && (
        <div class="card empty reveal">
          <span class="big">No portrait yet</span>
          Import your AI history with <code>persnally setup</code>, then synthesize — five minutes from install to a
          profile that will unsettle you a little.
        </div>
      )}
      {profile && <Portrait client={client} profile={profile} />}
    </div>
  );
}
