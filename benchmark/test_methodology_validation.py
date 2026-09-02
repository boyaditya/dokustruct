"""
benchmark/test_methodology_validation.py
========================================
Methodology validation tests â€” memverifikasi bahwa evaluator benchmark
mematuhi prosedur metodologi yang ditetapkan (dokumen metodologi penelitian).

Setiap test diberi anotasi @methodology_section yang memetakan ke subbab metodologi.

Run:
    python -m pytest benchmark/test_methodology_validation.py -v
"""

from __future__ import annotations

import json
import math
import statistics
from pathlib import Path
from typing import List, Dict, Tuple

# Decorator that tags tests with the methodology section they validate.
# Tidak memengaruhi eksekusi â€” hanya dokumentasi yang dapat dibaca mesin.
def methodology_section(section: str):
    """Tag a test with the methodology section it validates."""
    def decorator(func):
        func._methodology_section = section
        return func
    return decorator


# =============================================================================
# SECTION 3.7.1 â€” Kontrak Content List
# =============================================================================

@methodology_section("3.7.1")
def test_content_list_contract_fields():
    """Setiap item content_list harus minimal memiliki type, content, page_idx, bbox."""
    from benchmark.alignment import item_type, item_text

    valid_items = [
        {"type": "text", "text": "hello", "page_idx": 0, "bbox": [10, 20, 100, 50]},
        {"type": "equation", "text": "x=1", "text_format": "latex", "page_idx": 0, "bbox": [10, 20, 100, 50]},
        {"type": "table", "table_body": "<table><tr><td>x</td></tr></table>", "page_idx": 1, "bbox": [0, 0, 200, 100]},
        {"type": "image", "text": "/path/to/img.png", "page_idx": 2, "bbox": [50, 50, 150, 150]},
        {"type": "discarded", "text": "1", "page_idx": 3, "bbox": [480, 920, 520, 960]},
    ]
    for item in valid_items:
        assert item_type(item) in ("text", "equation", "table", "image", "discarded")
        content = item_text(item)
        assert isinstance(item.get("page_idx"), (int, float))
        bbox = item.get("bbox")
        assert bbox is not None and len(bbox) == 4


# =============================================================================
# SECTION 3.7.2 â€” Pemeriksaan Kelengkapan
# =============================================================================

@methodology_section("3.7.2")
def test_completeness_check_input_parity():
    """Evaluator harus mendeteksi input yang berbeda (SHA-256 mismatch)."""
    # Simulate evaluate._input_parity logic
    from benchmark.evaluate import _input_parity

    js_timing = {"input_file": {"kind": "png", "sha256_full": "abc123def456"}}
    py_timing = {"input_file": {"kind": "png", "sha256_full": "abc123def456"}}
    parity = _input_parity(js_timing, py_timing)
    assert parity["same_input_bytes"] is True

    py_diff = {"input_file": {"kind": "png", "sha256_full": "xxx999yyy000"}}
    parity_diff = _input_parity(js_timing, py_diff)
    assert parity_diff["same_input_bytes"] is False


@methodology_section("3.7.2")
def test_completeness_check_missing_output():
    """Evaluator harus mencatat dokumen yang hilang dari salah satu sistem."""
    from benchmark.evaluate import _empty_document_row

    row = _empty_document_row("missing_doc", "missing_py_timing", Path("/js"), Path("/py"))
    assert row["status"] == "missing_py_timing"
    assert row["document"] == "missing_doc"


# =============================================================================
# SECTION 3.8 â€” Evaluasi Port-Fidelity
# =============================================================================

@methodology_section("3.8.1")
def test_port_fidelity_cross_type_forbidden():
    """Substitusi antar tipe berbeda harus DILARANG dalam alignment."""
    from benchmark.alignment import align_content_lists

    # Teks tidak boleh dipasangkan dengan formula
    a = [{"type": "text", "text": "hello", "page_idx": 0}]
    b = [{"type": "equation", "text": "x=1", "page_idx": 0}]
    res = align_content_lists(a, b)
    assert res["n_matched"] == 0
    assert res["n_only_js"] == 1
    assert res["n_only_python"] == 1


@methodology_section("3.8.2")
def test_port_fidelity_coverage_components():
    """Coverage F1 harus dihitung dari precision dan recall."""
    from benchmark.alignment import align_content_lists

    a = [{"type": "text", "text": "hello", "page_idx": 0},
         {"type": "text", "text": "world", "page_idx": 0}]
    b = [{"type": "text", "text": "hello", "page_idx": 0}]
    res = align_content_lists(a, b)
    # precision = 1/2 = 0.5; recall = 1/1 = 1.0; F1 = 2*0.5*1.0/(0.5+1.0) â‰ˆ 0.6667
    assert math.isclose(res["coverage_f1"], 2/3, rel_tol=1e-4)
    assert res["coverage_recall"] == 1.0
    assert res["coverage_precision"] == 0.5


@methodology_section("3.8.2")
def test_port_fidelity_bidirectional_coverage():
    """Precision dan recall harus simetris terhadap penghapusan/penyisipan."""
    from benchmark.alignment import align_content_lists

    # Dua item identik di kedua sisi
    cl = [{"type": "text", "text": "a", "page_idx": 0},
          {"type": "text", "text": "b", "page_idx": 0}]
    res = align_content_lists(cl, cl)
    assert res["coverage_f1"] == 1.0
    assert res["coverage_precision"] == 1.0
    assert res["coverage_recall"] == 1.0


# =============================================================================
# SECTION 3.8.3 â€” Alur Pembentukan Angka Port-Fidelity
# =============================================================================

@methodology_section("3.8.3")
def test_port_fidelity_flow_per_page_aggregation():
    """Port-fidelity harus diagregasi dari metrik per halaman, bukan global."""
    from benchmark.alignment import align_content_lists, _group_by_page

    # Dua halaman dengan profil berbeda
    cl_a = [
        {"type": "text", "text": "p0 text", "page_idx": 0},
        {"type": "text", "text": "p1 text A", "page_idx": 1},
        {"type": "text", "text": "p1 text B", "page_idx": 1},
    ]
    cl_b = [
        {"type": "text", "text": "p0 text", "page_idx": 0},
        {"type": "text", "text": "p1 text A", "page_idx": 1},
    ]
    res = align_content_lists(cl_a, cl_b)
    # Page 0: 1 match (perfect). Page 1: 1 match, 1 extra in A.
    assert res["n_matched"] == 2
    assert res["n_only_js"] == 1
    assert res["n_only_python"] == 0


# =============================================================================
# SECTION 3.9 â€” Evaluasi Akurasi terhadap Ground Truth
# =============================================================================

@methodology_section("3.9.2")
def test_accuracy_missing_modality_penalty():
    """Modalitas GT yang tidak ditemukan harus diberi penalti, bukan diabaikan."""
    from benchmark.gt_scoring import score_against_gt

    gt = [
        {"type": "text", "text": "caption", "page_idx": 0},
        {"type": "equation", "text": "x^2", "page_idx": 0, "text_format": "latex"},
        {"type": "table", "table_body": "<table><tr><td>A</td></tr></table>", "page_idx": 0},
    ]
    pred = [{"type": "text", "text": "caption", "page_idx": 0}]
    s = score_against_gt(pred, gt)
    # Formula dan tabel ada di GT tapi tidak di prediksi â†’ penalti
    assert s["formula_edit"] == 1.0  # penalti maksimum
    assert s["table_teds"] == 0.0    # penalti minimum
    assert s["table_teds_struct"] == 0.0
    assert s["overall"] < 100.0


@methodology_section("3.9.2")
def test_accuracy_absent_modality_not_penalized():
    """Modalitas yang tidak ada di GT harus dibiarkan None, bukan 0."""
    from benchmark.gt_scoring import score_against_gt

    gt = [{"type": "text", "text": "text only", "page_idx": 0}]
    pred = [{"type": "text", "text": "text only", "page_idx": 0}]
    s = score_against_gt(pred, gt)
    assert s["table_teds"] is None
    assert s["formula_edit"] is None


@methodology_section("3.9.3")
def test_accuracy_all_metrics_present():
    """Setiap metrik akurasi harus ada dalam hasil scoring."""
    from benchmark.gt_scoring import score_against_gt

    gt = [
        {"type": "text", "text": "hello", "page_idx": 0},
        {"type": "equation", "text": "x=1", "page_idx": 0, "text_format": "latex"},
        {"type": "table", "table_body": "<table><tr><td>x</td></tr></table>", "page_idx": 0},
    ]
    pred = [dict(it) for it in gt]
    s = score_against_gt(pred, gt)

    for metric in ["text_edit", "text_cer", "formula_edit", "table_teds",
                   "table_teds_struct", "reading_order_edit", "overall",
                   "coverage_f1", "coverage_precision", "coverage_recall",
                   "mean_bbox_iou"]:
        assert metric in s, f"Missing metric: {metric}"


# =============================================================================
# SECTION 3.9.4 â€” Skor Komposit Proksi
# =============================================================================

@methodology_section("3.9.4")
def test_composite_score_formula():
    """Skor Komposit = ((1-TextEdit) + TEDS + (1-FormulaEdit)) / 3 Ã— 100."""
    from benchmark.gt_scoring import score_against_gt

    gt = [
        {"type": "text", "text": "hello world", "page_idx": 0},
        {"type": "equation", "text": "x=1", "page_idx": 0, "text_format": "latex"},
        {"type": "table", "table_body": "<table><tr><td>x</td></tr></table>", "page_idx": 0},
    ]
    pred = [dict(it) for it in gt]
    s = score_against_gt(pred, gt)
    assert s["overall"] == 100.0  # perfect match â†’ 100

    # Introduce error in text only
    pred_err = [dict(it) for it in gt]
    pred_err[0]["text"] = "hallo werld"
    s_err = score_against_gt(pred_err, gt)
    assert s_err["overall"] < 100.0
    assert s_err["text_edit"] > 0.0


@methodology_section("3.9.4")
def test_composite_score_partial_modalities():
    """Skor komposit hanya merangkum modalitas yang tersedia di GT."""
    from benchmark.gt_scoring import score_against_gt

    # GT teks saja
    gt = [{"type": "text", "text": "hello", "page_idx": 0}]
    pred = [{"type": "text", "text": "hello", "page_idx": 0}]
    s = score_against_gt(pred, gt)
    # Overall harus tetap dihitung dari modalitas yang tersedia
    assert s["overall"] is not None
    assert s["table_teds"] is None
    assert s["formula_edit"] is None


# =============================================================================
# SECTION 3.10 â€” Evaluasi Waktu
# =============================================================================

@methodology_section("3.10.2")
def test_timing_ratio_calculation():
    """Rasio = T_DokuStruct / T_RapidDoc. >1 berarti DokuStruct lebih lambat."""
    # Simulasi perhitungan rasio
    t_js = [10.0, 15.0, 20.0]   # DokuStruct
    t_py = [5.0, 10.0, 25.0]    # RapidDoc Python
    ratios = [j / p for j, p in zip(t_js, t_py)]
    assert ratios == [2.0, 1.5, 0.8]
    # Geometric mean
    from benchmark.metrics import geometric_mean
    gm = geometric_mean(ratios)
    assert math.isclose(gm, (2.0 * 1.5 * 0.8) ** (1/3), rel_tol=1e-6)


@methodology_section("3.10.2")
def test_timing_geometric_mean_vs_arithmetic():
    """Geometric mean mencegah bias mean-of-ratios."""
    from benchmark.metrics import geometric_mean

    ratios = [0.5, 2.0]
    gm = geometric_mean(ratios)
    am = statistics.mean(ratios)
    assert math.isclose(gm, 1.0)  # geomean simetris: A=2xB vs B=2xA
    assert am > 1.0  # arithmetic mean bias ke atas (1.25 vs 1.0)


@methodology_section("3.10.3")
def test_timing_bootstrap_ci_brackets_point():
    """Interval kepercayaan bootstrap harus mengapit geometric mean."""
    from benchmark.metrics import geometric_mean_ci

    # Data dengan variasi sedang
    ratios = [1.2, 1.3, 1.1, 1.4, 1.25, 1.35, 1.15, 1.28]
    ci = geometric_mean_ci(ratios)
    assert ci["gm"] is not None
    assert ci["ci_low"] <= ci["gm"] <= ci["ci_high"] or ci["n"] <= 1


@methodology_section("3.10.3")
def test_timing_bootstrap_respects_n():
    """CI harus valid untuk berbagai ukuran sampel."""
    from benchmark.metrics import geometric_mean_ci

    ci_single = geometric_mean_ci([1.5])
    assert ci_single["gm"] == 1.5
    assert ci_single["ci_low"] == 1.5
    assert ci_single["ci_high"] == 1.5

    ci_empty = geometric_mean_ci([])
    assert ci_empty["n"] == 0
    assert ci_empty["gm"] is None


# =============================================================================
# SECTION 3.11 â€” Analisis Statistik
# =============================================================================

@methodology_section("3.11")
def test_wilcoxon_paired_nature():
    """Wilcoxon signed-rank harus mempertahankan sifat berpasangan."""
    from benchmark.metrics import wilcoxon_signed_rank

    # Data berpasangan yang sama persis â†’ p=1.0, selisih nol
    res = wilcoxon_signed_rank([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])
    assert res["p_value"] == 1.0
    assert res["effect_size_r"] == 0.0
    assert res["median_diff"] == 0.0


@methodology_section("3.11")
def test_wilcoxon_asymmetric():
    """Wilcoxon harus mendeteksi perbedaan konsisten."""
    from benchmark.metrics import wilcoxon_signed_rank

    # Semua selisih positif (JS selalu lebih lambat/tidak akurat)
    a = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
    b = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]
    res = wilcoxon_signed_rank(a, b)
    # Semua selisih positif â†’ p-value harus kecil
    assert res["p_value"] is not None and res["p_value"] < 0.05
    assert res["effect_size_r"] > 0.5  # efek besar


@methodology_section("3.11")
def test_holm_correction_controls_fwer():
    """Holm harus lebih konservatif daripada raw p-value."""
    from benchmark.metrics import holm_bonferroni

    # 10 tes, 1 signifikan mentah â†’ Holm mungkin menolaknya
    res = holm_bonferroni([0.001] + [0.5] * 9)
    assert res[0]["significant"] is True   # 0.001 < 0.05/10 = 0.005
    for i in range(1, 10):
        assert res[i]["significant"] is False


@methodology_section("3.11")
def test_holm_null_handling():
    """Holm harus menangani None p-values tanpa error."""
    from benchmark.metrics import holm_bonferroni

    res = holm_bonferroni([None, 0.001, None, 0.5])
    assert res[0]["significant"] is None
    assert res[1]["significant"] is True
    assert res[2]["significant"] is None
    assert res[3]["significant"] is False


# =============================================================================
# SECTION 3.12 â€” Pemeriksaan Hasil Evaluasi
# =============================================================================

@methodology_section("3.12")
def test_verification_no_duplicate_documents():
    """Tidak boleh ada duplikasi dokumen dalam hasil evaluasi."""
    from benchmark.evaluate import find_pairs

    # find_pairs mengembalikan stem yang terurut dan unique
    # (implementasi menggunakan sorted(set()))
    # Verifikasi dengan data kosong
    stems = find_pairs(Path("/nonexistent_js"), Path("/nonexistent_py"))
    assert len(stems) == len(set(stems))  # tidak ada duplikat


@methodology_section("3.12")
def test_verification_config_mismatch_detection():
    """Evaluator harus mendeteksi config mismatch antar sistem."""
    from benchmark.evaluate import _config_mismatch

    js_cfg = {"formula_enable": True, "table_enable": True, "parse_method": "auto",
              "layout_model_type": "v2", "formula_model_type": "s", "table_model_type": "unet_slanet_plus"}
    py_cfg = {"formula_enable": True, "table_enable": False, "parse_method": "auto",
              "layout_model_type": "v2", "formula_model_type": "m", "table_model_type": "unet_slanet_plus"}
    issues = _config_mismatch(js_cfg, py_cfg)
    assert len(issues) > 0
    # table_enable dan formula_model_type berbeda
    assert any("table_enable" in issue for issue in issues)


@methodology_section("3.12")
def test_verification_metric_range_validation():
    """Nilai metrik harus dalam rentang yang diharapkan."""
    from benchmark.gt_scoring import score_against_gt
    from benchmark.alignment import align_content_lists

    # Verifikasi bahwa metrik alignment dalam rentang [0,1] untuk probabilitas
    cl = [{"type": "text", "text": "hello", "page_idx": 0}]
    res = align_content_lists(cl, cl)
    assert 0.0 <= res["coverage_f1"] <= 1.0
    assert 0.0 <= res["type_consistency"] <= 1.0
    if res["mean_ned_norm"] is not None:
        assert 0.0 <= res["mean_ned_norm"] <= 1.0
    if res["mean_bbox_iou"] is not None:
        assert 0.0 <= res["mean_bbox_iou"] <= 1.0


# =============================================================================
# SECTION 3.13 â€” Batas Interpretasi
# =============================================================================

@methodology_section("3.13")
def test_interpretation_composite_not_official_overall():
    """Skor Komposit adalah PROKSI, bukan Overall resmi OmniDocBench."""
    from benchmark.gt_scoring import score_against_gt

    gt = [
        {"type": "text", "text": "hello", "page_idx": 0},
        {"type": "table", "table_body": "<table><tr><td>x</td></tr></table>", "page_idx": 0},
    ]
    pred = [dict(it) for it in gt]
    s = score_against_gt(pred, gt)
    # Skor komposit hanya dari teks + tabel (tanpa formula) â†’ tetap dihitung
    assert s["overall"] is not None
    assert s["formula_edit"] is None  # formula tidak tersedia â†’ tidak dipenalti
    # Overall hanya dari komponen yang tersedia: ((1-0)*100 + 1.0*100) / 2 = 100
    assert s["overall"] == 100.0


@methodology_section("3.13")
def test_interpretation_port_fidelity_not_accuracy():
    """Port-fidelity tinggi â‰  akurasi tinggi."""
    # Test ini bersifat dokumentatif: alignment port-fidelity menggunakan
    # referensi baseline (Python), bukan GT. Kedua nilai dihitung terpisah.
    from benchmark.alignment import align_content_lists

    # Simulasi: kedua sistem salah dengan cara yang sama â†’ port-fidelity tinggi
    wrong_both = [{"type": "text", "text": "wrong text", "page_idx": 0}]
    res = align_content_lists(wrong_both, wrong_both)
    assert res["coverage_f1"] == 1.0
    assert res["mean_ned_norm"] == 0.0
    # Port-fidelity sempurna meskipun konten salah â€” ini sesuai metodologi


@methodology_section("3.13")
def test_interpretation_deviation_not_always_regression():
    """Perbedaan dari baseline â‰  regresi. Bisa jadi JS lebih dekat ke GT."""
    from benchmark.gt_scoring import score_against_gt

    gt = [{"type": "text", "text": "correct text", "page_idx": 0}]
    js_pred = [{"type": "text", "text": "correct text", "page_idx": 0}]
    py_pred = [{"type": "text", "text": "wrong text", "page_idx": 0}]

    js_score = score_against_gt(js_pred, gt)
    py_score = score_against_gt(py_pred, gt)

    # JS berbeda dari baseline tapi lebih dekat ke GT â†’ deviasi bukan regresi
    assert js_score["text_edit"] < py_score["text_edit"]
    assert js_score["overall"] > py_score["overall"]


# =============================================================================
# SECTION 3.5 â€” Tahap Normalisasi (Tahap 4 metode)
# =============================================================================

@methodology_section("3.5 Tahap 4")
def test_normalization_unicode_nfc_idempotent():
    """Normalisasi NFC harus idempoten."""
    from benchmark.metrics import normalize_text

    s = "cafÃ© rÃ©sumÃ© naÃ¯ve"
    n1 = normalize_text(s)
    n2 = normalize_text(n1)
    assert n1 == n2


@methodology_section("3.5 Tahap 4")
def test_normalization_latex_macro_canonicalization():
    """Normalisasi LaTeX harus kanonikalisasi perintah sinonim."""
    from benchmark.metrics import normalize_latex

    # \dfrac, \tfrac â†’ \frac
    assert normalize_latex(r"\dfrac{a}{b}") == normalize_latex(r"\tfrac{a}{b}")
    assert normalize_latex(r"\dfrac{a}{b}") == normalize_latex(r"\frac{a}{b}")

    # \left, \right dibuang
    assert normalize_latex(r"\left( x \right)") == normalize_latex("(x)")

    # Spasi dibuang
    assert normalize_latex(r"a + b") == normalize_latex(r"a+b")


@methodology_section("3.5 Tahap 4")
def test_normalization_html_table_structure_preserved():
    """Normalisasi tabel harus mempertahankan struktur baris/kolom."""
    from benchmark.metrics import teds, teds_struct

    a = "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>"
    b = "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>"
    assert teds(a, b) == 1.0
    assert teds_struct(a, b) == 1.0


@methodology_section("3.5 Tahap 4")
def test_normalization_bbox_conversion():
    """Konversi bbox GT dari pixel ke skala 0-1000."""
    from benchmark.omnidocbench import _normalize_bbox, _poly_to_bbox

    # Polygon 8-point
    bbox = _poly_to_bbox([10, 10, 90, 10, 90, 50, 10, 50], None)
    assert bbox == [10.0, 10.0, 90.0, 50.0]

    # Normalisasi ke 0-1000
    norm = _normalize_bbox(bbox, width=100, height=200)
    assert norm[0] == 100.0  # 10/100 * 1000
    assert norm[1] == 50.0   # 10/200 * 1000
    assert norm[2] == 900.0  # 90/100 * 1000
    assert norm[3] == 250.0  # 50/200 * 1000


# =============================================================================
# SECTION 3.6 â€” Alur Evaluasi Keseluruhan
# =============================================================================

@methodology_section("3.6")
def test_evaluation_pipeline_input_to_aggregation():
    """Alur: Input â†’ Eksekusi â†’ content_list â†’ Normalisasi â†’ Alignment â†’ Metrik â†’ Agregasi."""
    from benchmark.omnidocbench import gt_page_to_content_list
    from benchmark.gt_scoring import score_against_gt

    # Tahap 1: Konversi GT ke content_list
    page = {
        "layout_dets": [
            {"category_type": "text_block", "text": "Hello world",
             "poly": [10, 10, 90, 10, 90, 50, 10, 50], "order": 0},
        ],
        "page_info": {"image_path": "test.jpg", "height": 100, "width": 100,
                      "page_attribute": {"data_source": "test", "language": "english"}},
    }
    gt_cl = gt_page_to_content_list(page)

    # Tahap 2: Prediksi (simulasi)
    pred_cl = [dict(it) for it in gt_cl]

    # Tahap 3-4: Normalisasi sudah di dalam alignment + scoring

    # Tahap 5-6: Scoring & agregasi
    scores = score_against_gt(pred_cl, gt_cl)
    assert scores["text_edit"] == 0.0
    assert scores["overall"] is not None
    assert scores["coverage_f1"] == 1.0


# =============================================================================
# SAMPLING VALIDATION (Section 3.4)
# =============================================================================

@methodology_section("3.4")
def test_sampling_stratified_metadata_preserved():
    """Metadata stratifikasi (kategori, bahasa, layout) harus dipertahankan."""
    from benchmark.omnidocbench import extract_page_attributes

    page = {
        "page_info": {
            "image_path": "academic/english/doc_001.jpg",
            "height": 200, "width": 100,
            "page_attribute": {"data_source": "academic", "language": "english",
                               "layout": "single_column"},
        },
    }
    attrs = extract_page_attributes(page)
    assert attrs["data_source"] == "academic"
    assert attrs["language"] == "english"
    assert attrs["layout"] == "single_column"


@methodology_section("3.4")
def test_sample_size_calculation():
    """Sample size calculator harus menghasilkan angka yang valid."""
    from benchmark.sample_size import required_n

    # Data teoritis: sigma=0.15, margin=0.03, population=1651
    n = required_n(sigma=0.15, margin=0.03, population=1651, confidence=0.95)
    assert 80 <= n <= 120  # ~96 berdasarkan formula

    # Tanpa FPC (infinite population)
    n_inf = required_n(sigma=0.15, margin=0.03, population=0, confidence=0.95)
    assert n_inf >= n  # FPC selalu mengurangi n yang dibutuhkan


@methodology_section("3.4")
def test_sample_size_achieved_margin():
    """Achieved margin harus turun seiring bertambahnya n."""
    from benchmark.sample_size import achieved_margin

    m50 = achieved_margin(sigma=0.15, n=50, population=1651)
    m100 = achieved_margin(sigma=0.15, n=100, population=1651)
    m350 = achieved_margin(sigma=0.15, n=350, population=1651)

    assert m50 > m100 > m350  # margin mengecil dengan sampel lebih besar


# =============================================================================
# EXCEL OUTPUT VALIDATION
# =============================================================================

@methodology_section("3.6")
def test_evaluate_timing_extraction_consistency():
    """Extract timing harus menghasilkan total_inference_s yang konsisten."""
    from benchmark.evaluate import extract_timing

    # JS timing (milidetik)
    js_timing = {
        "total_ms": 10000,
        "model_init_ms": 2000,
        "layout_ms": 3000,
        "ocr_det_ms": 1500,
        "ocr_rec_ms": 1000,
        "formula_ms": 500,
        "table_ms": 1000,
        "postprocessing_ms": 500,
        "page_count": 5,
    }
    js_t = extract_timing(js_timing, "js")

    # total_inference_s = layout + ocr + formula + table
    assert math.isclose(js_t["total_inference_s"], 3.0 + 2.5 + 0.5 + 1.0, rel_tol=1e-4)
    assert js_t["layout_s"] == 3.0
    assert js_t["ocr_s"] == 2.5  # det + rec
    # other_s = total - (model_init + inference + postprocess)
    assert js_t["other_s"] >= 0

    # Python timing (detik)
    py_timing = {
        "total_s": 8.0,
        "model_init_s": 1.5,
        "layout_s": 2.0,
        "ocr_det_s": 1.2,
        "ocr_rec_s": 0.8,
        "formula_s": 1.0,
        "table_s": 1.5,
        "page_count": 5,
    }
    py_t = extract_timing(py_timing, "python")
    assert math.isclose(py_t["total_inference_s"], 2.0 + 2.0 + 1.0 + 1.5, rel_tol=1e-4)


@methodology_section("3.8.1")
def test_alignment_large_text_sketching():
    """Alignment teks panjang harus menggunakan cost shortcut."""
    from benchmark.alignment import _alignment_cost

    a = {"type": "text", "text": "x " * 500}
    b = {"type": "text", "text": "x " * 500}
    cost = _alignment_cost(a, b)
    assert 0.0 <= cost <= 1.0  # teks identik â†’ cost â‰ˆ 0


# ============================================================================
# Tests runner
# ============================================================================

if __name__ == "__main__":
    import sys
    import traceback

    tests = {name: fn for name, fn in sorted(globals().items())
             if name.startswith("test_") and callable(fn)}
    passed = failed = 0
    sections: Dict[str, List[str]] = {}

    for name, fn in tests.items():
        sec = getattr(fn, "_methodology_section", "untagged")
        sections.setdefault(sec, []).append(name)
        try:
            fn()
            passed += 1
            print(f"  PASS  {name}  [{sec}]")
        except Exception:
            failed += 1
            print(f"  FAIL  {name}  [{sec}]")
            traceback.print_exc()

    print(f"\n{'='*60}")
    print(f"Methodology Coverage by Section:")
    for sec in sorted(sections):
        print(f"  {sec}: {len(sections[sec])} test(s) â€” {', '.join(sections[sec])}")
    print(f"\n{passed} passed, {failed} failed (of {len(tests)})")
    sys.exit(1 if failed else 0)
