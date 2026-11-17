# Vale bundled with its styles, so it needs no `vale sync`. Mirrors nixpkgs'
# vale.withStyles, plus this repository's own styles under .vale/styles and
# the en_GB Hunspell dictionary for British spelling. Adapted from the
# declarative_laptop repository's packages/vale.nix.
{ pkgs }:
pkgs.symlinkJoin {
  name = "vale-with-house-styles-${pkgs.vale.version}";
  paths = [
    pkgs.vale
    pkgs.valeStyles.write-good
    pkgs.valeStyles.proselint
  ];
  nativeBuildInputs = [ pkgs.makeBinaryWrapper ];
  postBuild = ''
    styles=$out/share/vale/styles
    cp -r --no-preserve=mode ${../.vale/styles}/. $styles/
    mkdir -p $styles/config/dictionaries
    ln -s ${pkgs.hunspellDicts.en_GB-ise}/share/hunspell/en_GB.{aff,dic} $styles/config/dictionaries/
    wrapProgram $out/bin/vale --set VALE_STYLES_PATH $styles
  '';
  meta.mainProgram = "vale";
}
