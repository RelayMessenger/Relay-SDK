// Offline comparison using the real installed OpenClaw resolver. No API, message, ACK, or configuration writes.
import { resolveStableChannelMessageIngress } from 'openclaw/plugin-sdk/channel-ingress-runtime';
const id='01a07f76-4e51-70e1-8b12-a269a5b1774b';
const common={channelId:'relay',accountId:'work',subject:{stableId:id,aliases:{handle:'iosf2b66952920'}},conversation:{kind:'direct',id:'01a07fbc-ffad-70cc-8df6-0cdb48e93ca2'},contextBinding:{agentId:'verification',sessionKey:'verification',messageId:'01a07fc1-0b02-71da-acdd-6553109822ca',inboundEventKind:'user_request'},dmPolicy:'allowlist',groupPolicy:'allowlist',policy:{groupAllowFromFallbackToAllowFrom:true},allowFrom:[id],groupAllowFrom:[id],useDefaultPairingStore:false};
const identity={key:'contactId',kind:'stable-id',entryIdPrefix:'relay-contact',aliases:[{key:'handle',kind:'username',normalize:value=>value.trim().replace(/^@/,'').toLowerCase(),dangerous:true}]};
for(const [name,descriptor] of [['current',identity],['distinct-field-entry-ids',{...identity,resolveEntryId:({entryIndex,fieldKey})=>`relay-contact-${entryIndex+1}:${fieldKey}`}],['no-prefix',{...identity,entryIdPrefix:undefined}]]) {
 const result=await resolveStableChannelMessageIngress({...common,identity:descriptor});
 console.log(JSON.stringify({case:name,ingress:result.ingress}));
}
