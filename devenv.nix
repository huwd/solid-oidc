{ pkgs, ... }:

{
  # Tools only. Secrets come from `with-secrets`; never load them here, or
  # every child process (including agent tool calls) would see them.
  #   devenv shell                                 # interactive shell
  #   devenv shell -- with-secrets pnpm run dev    # one-off, with secrets
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_26;
    # pnpm switches itself to the version in package.json `packageManager`.
    pnpm.enable = true;
  };

  packages = [
    pkgs.actionlint
    pkgs.shellcheck
    pkgs.sops
  ];
}
