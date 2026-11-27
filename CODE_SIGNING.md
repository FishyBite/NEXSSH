# Code signing policy

VEXSSH is preparing to apply for free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/). Existing Windows releases are unsigned.

The proposed signing scope is the Windows x64 Online Setup and Portable executables built from this repository. GitHub Actions will build the artifacts from reviewed source. Each signing request will require manual approval before signed artifacts are published. Microsoft’s WebView2 bootstrapper carries its own signature. The project will disclose its inclusion for SignPath’s review.

- Committer, reviewer, and signing approver: [Jason Sariwating, repository maintainer](https://github.com/FishyBite).

VEXSSH connects to SSH and database endpoints selected by the operator. Host-to-host SFTP transfers pass through the computer running VEXSSH. Online Setup checks for WebView2 and invokes Microsoft’s bootstrapper if the runtime is missing. Microsoft handles the runtime download. [Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement)

See [GitHub Releases](https://github.com/FishyBite/VEXSSH/releases) for Windows downloads and the checksums supplied with each release.
