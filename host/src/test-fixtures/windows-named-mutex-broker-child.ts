import { WindowsNamedMutexBroker } from "../windows-named-mutex-broker.js";

const name = process.argv[2];
if (typeof name !== "string") process.exitCode = 1;
else {
  const broker = new WindowsNamedMutexBroker();
  void broker.acquire(name, { timeoutMs: 5_000 }).then(
    () => {
      process.send?.("acquired");
      setInterval(() => undefined, 1_000);
    },
    () => {
      process.exitCode = 1;
    },
  );
}
