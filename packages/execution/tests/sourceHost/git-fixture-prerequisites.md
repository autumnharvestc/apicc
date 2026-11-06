The Git transport tests require Docker and the owned Linux fixture image. They fail setup explicitly if it is unavailable; required SSH coverage is never skipped.

Build the test-only image from the repository root before the named tests:

```powershell
docker build -t apicc-f7g-ssh-fixture:node22 -f packages/execution/tests/sourceHost/git-fixture.Dockerfile .
```

`APICC_GIT_FIXTURE_IMAGE` can select an administrator-prepared equivalent image. Each fixture creates a fresh init-owned container with loopback-only published ports, a synthetic repository, CA, server certificate, encrypted client key and strict host-key authority. It removes the container, volumes and host directory in `finally`. The image contains test prerequisites only; the product never installs tools or trusts this CA globally.
