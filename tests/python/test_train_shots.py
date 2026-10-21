"""Real-shot CSV, family top-5, and the report-only displacement cap."""

import json
import os
import shutil
from pathlib import Path

import numpy as np
import pytest

from fontsnap_ref.evaluate import CONFIGS
from fontsnap_ref.pipeline import nz
from train.paths import OUT, REALSHOT_LABELS
from train.samples import Split, build_specs
from train.shots import (
    SHOT_COLUMNS,
    ShotLabel,
    displacement_report,
    format_displacement,
    load_shot_labels,
    main,
    score_shots,
)

HEADER = "image,label,family_key,source,split\n"


def _write(path: Path, body: str) -> Path:
    path.write_text(HEADER + body, encoding="utf-8")
    return path


def test_committed_labels_are_header_only():
    assert REALSHOT_LABELS.read_text(encoding="utf-8") == HEADER
    assert load_shot_labels(REALSHOT_LABELS) == ()
    readme = (REALSHOT_LABELS.parent / "README.md").read_text(encoding="utf-8")
    assert ",".join(SHOT_COLUMNS) in readme
    assert "out/realshots/images" in readme
    assert "0.02" in readme


def test_loader_accepts_a_real_row_and_rejects_a_bad_one(tmp_path):
    path = _write(tmp_path / "ok.csv", "a.png,Inter Tight,intertight,fontsource,real\n")
    assert load_shot_labels(path) == (ShotLabel("a.png", "Inter Tight", "intertight", "fontsource", "real"),)
    empty_key = _write(tmp_path / "empty.csv", "b.png,Inter Tight,,,real\n")
    assert load_shot_labels(empty_key)[0].family_key == ""
    with pytest.raises(ValueError):
        load_shot_labels(_write(tmp_path / "slash.csv", "sub/a.png,Inter,inter,fontsource,real\n"))
    with pytest.raises(ValueError):
        load_shot_labels(_write(tmp_path / "dot.csv", "../a.png,Inter,inter,fontsource,real\n"))
    with pytest.raises(ValueError):
        load_shot_labels(_write(tmp_path / "key.csv", "a.png,Inter Tight,inter,fontsource,real\n"))
    with pytest.raises(ValueError):
        load_shot_labels(_write(tmp_path / "src.csv", "a.png,Inter,inter,nope,real\n"))
    with pytest.raises(ValueError):
        load_shot_labels(_write(tmp_path / "split.csv", "a.png,Inter,inter,fontsource,train\n"))
    assert nz("Inter Tight") == "intertight"


def test_score_matches_evaluate_configs():
    assert set(CONFIGS) == {"bare", "best"}
    labels = (ShotLabel("a.png", "Inter Tight", "intertight", "", "real"),)
    preds = {"a.png": {"bare": ["intertight"], "best": ["inter"]}}
    metrics = score_shots(labels, preds)
    assert metrics["bare"] == {"n": 1, "top1": 100.0, "top5": 100.0}
    assert metrics["best"] == {"n": 1, "top1": 100.0, "top5": 100.0}
    missed = score_shots(labels, {"a.png": {"bare": ["roboto"], "best": ["roboto"]}})
    assert missed["best"]["top1"] == 0.0
    assert missed["best"]["top5"] == 0.0


def test_displacement_above_two_percent_is_not_enforced(tmp_path, capsys):
    before = {"preds": {"a.png": {"best": ["inter"]}, "b.png": {"best": ["roboto"]}}}
    after = {"preds": {"b.png": {"best": ["inter"]}, "c.png": {"best": ["roboto"]}}}
    report = displacement_report(before, after)
    assert report["n"] == 1
    assert report["top1_changed"] == 1.0
    assert report["max_displacement"] == 0.02
    assert report["enforced"] is False
    with pytest.raises(ValueError, match="best family"):
        displacement_report({"preds": {"a.png": {}}}, {"preds": {"a.png": {"best": ["inter"]}}})
    same = displacement_report(before, before)
    assert same["top1_changed"] == 0.0
    assert same["n"] == 2
    before_path = tmp_path / "before.json"
    after_path = tmp_path / "after.json"
    before_path.write_text(json.dumps(before), encoding="utf-8")
    after_path.write_text(json.dumps(after), encoding="utf-8")
    dest = OUT / f"pytest-displacement-{os.getpid()}.json"
    try:
        assert main(["displace", "--before", str(before_path), "--after", str(after_path), "--out", str(dest)]) == 0
        text = capsys.readouterr().out
        assert text.strip() == format_displacement(report)
        assert "max_displacement=0.02" in text
        assert "enforced=false" in text
        assert json.loads(dest.read_text(encoding="utf-8"))["enforced"] is False
    finally:
        dest.unlink(missing_ok=True)
    assert main(["displace", "--before", str(before_path), "--after", str(after_path), "--out", str(tmp_path / "no.json")]) == 2


def test_check_cli_on_the_committed_file():
    assert main(["check", "--labels", str(REALSHOT_LABELS)]) == 0


def test_eval_rejects_an_empty_file_and_a_directory_outside_out(tmp_path, capsys):
    assert main(["eval", "--labels", str(REALSHOT_LABELS), "--images", str(tmp_path)]) == 2
    assert "no shot labels" in capsys.readouterr().err
    labels = tmp_path / "labels.csv"
    _write(labels, "a.png,ABeeZee,abeezee,,real\n")
    assert main(["eval", "--labels", str(labels), "--images", str(tmp_path)]) == 2
    assert "out/" in capsys.readouterr().err


def test_eval_cli_reports_family_top5(monkeypatch, capsys):
    root = OUT / "realshots" / f"pytest-eval-{os.getpid()}"
    root.mkdir(parents=True)
    dest = OUT / f"pytest-shots-{os.getpid()}.json"
    try:
        from train.render import render_sample

        spec = build_specs(n_classes=1, split=Split.TRAIN, per_class=1)[0]
        render_sample(spec).save(root / "a.png")
        labels = root / "labels.csv"
        _write(labels, "a.png,ABeeZee,abeezee,,real\n")

        class _Model:
            def __init__(self, path, threads=0):
                self.path = path

            def probs(self, batch):
                assert batch.shape == (1, 3, 320, 320)
                row = np.zeros(3665, np.float32)
                row[0] = 1
                return row

        monkeypatch.setattr("fontsnap_ref.pipeline.Model", _Model)
        code = main(
            [
                "eval",
                "--labels",
                str(labels),
                "--images",
                str(root),
                "--model",
                str(root / "unused.onnx"),
                "--out",
                str(dest),
            ]
        )
        assert code == 0, capsys.readouterr()
        printed = json.loads(capsys.readouterr().out)
        assert printed["best"]["n"] == 1
        assert printed["best"]["top1"] == 100.0
        assert printed["best"]["top5"] == 100.0
        assert printed["bare"]["top1"] == 100.0
        assert json.loads(dest.read_text(encoding="utf-8")) == printed
    finally:
        shutil.rmtree(root, ignore_errors=True)
        dest.unlink(missing_ok=True)


def test_train_main_dispatches_shots():
    from train.__main__ import main as train_main

    assert train_main(["shots", "check"]) == 0
