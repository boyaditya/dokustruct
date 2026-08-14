/**
 * PORTING NOTE: This is a browser-specific progress tracking system.
 * Python baseline does not have granular progress tracking at this level.
 * 
 * This module provides accurate progress tracking for document processing pipeline
 * by counting actual work units (pages, regions, formulas, tables) processed by each model.
 */

/**
 * Progress tracker for document processing pipeline.
 * Tracks progress across multiple stages with accurate work unit counting.
 */
export class ProgressTracker {
  /**
   * @param {Function|null} onProgress - Callback(stage, current, total, percent)
   */
  constructor(onProgress = null) {
    this.onProgress = onProgress;
    this.stages = {};
    this.totalWorkUnits = 0;
    this.completedWorkUnits = 0;
    this.stageWeights = {
      orientation: 0.02,    // 2% - quick classification per page
      layout: 0.12,         // 12% - layout detection per page
      region_collect: 0.02, // 2% - collecting regions
      formula: 0.18,        // 18% - formula recognition (heavy, LaTeX decoding)
      ocr_det: 0.22,        // 22% - OCR detection (many text regions)
      ocr_rec: 0.20,        // 20% - OCR recognition
      table: 0.16,          // 16% - table recognition (heavy)
      seal_ocr: 0.02,       // 2% - seal OCR (usually few seals)
      // Note: Total = 94%, leaving 6% buffer for untracked post-processing
      // (reading order, content assembly, markdown generation)
    };
  }

  /**
   * Initialize stage with expected work units.
   * @param {string} stage - Stage name
   * @param {number} total - Total work units for this stage
   */
  initStage(stage, total) {
    if (total <= 0) return;
    
    const weight = this.stageWeights[stage] || 0.05;
    const weightedUnits = total * weight;
    
    this.stages[stage] = {
      current: 0,
      total,
      weight,
      weightedTotal: weightedUnits,
      weightedCompleted: 0,
    };
    
    this.totalWorkUnits += weightedUnits;
  }

  /**
   * Update progress for a stage.
   * @param {string} stage - Stage name
   * @param {number} current - Current completed work units
   * @param {number} total - Total work units (optional, uses initialized value if not provided)
   */
  update(stage, current, total = null) {
    if (!this.stages[stage]) {
      // Auto-initialize if not already initialized
      if (total != null && total > 0) {
        this.initStage(stage, total);
      } else {
        return;
      }
    }

    const stageData = this.stages[stage];
    
    // Update total if provided
    if (total != null && total !== stageData.total) {
      const oldWeighted = stageData.weightedTotal;
      stageData.total = total;
      stageData.weightedTotal = total * stageData.weight;
      this.totalWorkUnits += stageData.weightedTotal - oldWeighted;
    }

    // Update current progress
    const oldCompleted = stageData.weightedCompleted;
    stageData.current = Math.min(current, stageData.total);
    stageData.weightedCompleted = (stageData.current / stageData.total) * stageData.weightedTotal;
    
    this.completedWorkUnits += stageData.weightedCompleted - oldCompleted;

    // Calculate overall percentage
    // Cap at 95% to account for untracked post-processing stages
    const rawPercent = this.totalWorkUnits > 0 
      ? (this.completedWorkUnits / this.totalWorkUnits) * 100
      : 0;
    
    const percent = Math.min(95, Math.max(0, rawPercent));

    // Notify callback
    if (this.onProgress) {
      this.onProgress(stage, stageData.current, stageData.total, percent);
    }
  }

  /**
   * Mark all stages as complete (call this when pipeline finishes).
   * This will report 100% progress. When called with a stage name, marks
   * only that stage as complete.
   */
  complete(stage = null) {
    if (stage) {
      if (this.stages[stage]) {
        this.update(stage, this.stages[stage].total);
      }
      return;
    }
    if (this.onProgress) {
      this.onProgress('complete', 1, 1, 100);
    }
  }

  /**
   * Get current overall progress percentage.
   * @returns {number} Progress percentage (0-100)
   */
  getPercent() {
    if (this.totalWorkUnits === 0) return 0;
    return Math.min(100, Math.max(0, (this.completedWorkUnits / this.totalWorkUnits) * 100));
  }

  /**
   * Get stage progress info.
   * @param {string} stage - Stage name
   * @returns {{current: number, total: number, percent: number}|null}
   */
  getStageProgress(stage) {
    const stageData = this.stages[stage];
    if (!stageData) return null;
    
    const percent = stageData.total > 0 
      ? (stageData.current / stageData.total) * 100
      : 0;
    
    return {
      current: stageData.current,
      total: stageData.total,
      percent,
    };
  }

  /**
   * Reset tracker to initial state.
   */
  reset() {
    this.stages = {};
    this.totalWorkUnits = 0;
    this.completedWorkUnits = 0;
  }

  /**
   * Get debug info for all stages.
   * @returns {object}
   */
  getDebugInfo() {
    return {
      stages: this.stages,
      totalWorkUnits: this.totalWorkUnits,
      completedWorkUnits: this.completedWorkUnits,
      overallPercent: this.getPercent(),
    };
  }
}
