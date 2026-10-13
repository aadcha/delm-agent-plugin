# DeLM for Pi

Build in parallel with collaborating [Pi](https://pi.dev) agents and deliver their changes to your project.

This package is installed as a Pi package. Its `bin/delm` runtime, the shared worker policy
(`worker.md`) and the two extensions are staged by the repository's build script:

```sh
./scripts/build.sh --host pi
pi install "$PWD/.build/plugin-pi"
```

Then, in the project you want to change:

```
/delm:run <your task>
```

DeLM prepares two private copies of the project, forks your conversation into two Pi workers,
coordinates them through a shared task board, and delivers the accepted result back into your
project. Text you send while the run is working is forwarded to both workers. `/delm:status` shows
the run; `/delm:stop` cancels it and saves unfinished changes.

Design and limitations: [docs/pi-integration.md](../../docs/pi-integration.md).
