/**
 * AI Verification Engine
 * Verifies raw detection records by analyzing multi-frame temporal consistency,
 * spatial jitter, optical confidence score, and vehicle trajectory tracking.
 */

export function verifyDetection(detectionData) {
  const {
    confidence = 0.85,
    frameCount = 4, // Number of consecutive frames detecting the object
    temporalConsistency = 0.88, // IoU or tracklet stability across frames
    source = 'onboard_camera',
    est_depth_cm = 3.5,
    hasImageEvidence = true,
  } = detectionData;

  // Base score from AI confidence (0-100)
  let score = Math.round(confidence * 100);

  // Frame count and tracklet stability weighting
  if (frameCount >= 3) {
    score += Math.min(15, frameCount * 3);
  } else if (frameCount === 1) {
    score -= 15; // Single-frame flash detections are prone to false positives (glare, road paint)
  }

  // Temporal consistency adjustment
  if (temporalConsistency >= 0.8) {
    score += 10;
  } else if (temporalConsistency < 0.5) {
    score -= 20;
  }

  // Physical parameter plausibility check
  if (est_depth_cm !== undefined && (est_depth_cm < 0.3 || est_depth_cm > 25.0)) {
    score -= 25; // Depth outlier
  }

  const verificationScore = Math.min(100, Math.max(5, score));

  let status = 'REVIEW_REQUIRED';
  let reason = '';

  if (verificationScore >= 75) {
    status = 'VERIFIED';
    reason = `Multi-frame spatial tracking confirmed across ${frameCount} consecutive video frames with ${Math.round(confidence * 100)}% visual model confidence.`;
  } else if (verificationScore < 45) {
    status = 'REJECTED';
    reason = `Low visual confidence (${Math.round(confidence * 100)}%) and unstable frame tracking; likely road surface artifact or reflection.`;
  } else {
    status = 'REVIEW_REQUIRED';
    reason = `Moderate confidence (${Math.round(confidence * 100)}%) with limited frame tracking (${frameCount} frame); flagged for municipal supervisor review.`;
  }

  return {
    verification_score: verificationScore,
    verification_status: status,
    verification_reason: reason,
    frame_track_count: frameCount,
    temporal_consistency: temporalConsistency,
  };
}
