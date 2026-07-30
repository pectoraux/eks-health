import { bootKernel, kernelSnapshot, getFlags, getScheduler } from "./src/kernel";

const info = bootKernel();
console.log("BOOTED:", info.name, info.version);
const snap = kernelSnapshot();
console.log("services:", snap.services.length);
console.log("contexts:", snap.contexts.length);
console.log("eventCatalog:", snap.eventCatalog.length);
console.log("flags:", snap.flags.definitions.length);
console.log("eventBus stats:", snap.eventBus);
console.log("gateway routes:", snap.gateway.routes.length);
console.log("security secrets:", snap.security.secrets.length);
console.log("scheduler handlers:", getScheduler().listHandlers().length);
const f = getFlags().evaluate("eks.flag.ai.agents", { developerId: "dev_1", userId: "u1" as never });
console.log("flag ai.agents eval:", f.variant, f.reason);
console.log("SMOKE OK");
