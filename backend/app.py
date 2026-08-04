"""
Pothole Reporting Backend
==========================

REST API that receives detection records from onboard vehicle units,
deduplicates reports of the same physical pothole, reverse-geocodes
locations, and serves aggregated data to the municipal dashboard.

Run:
    pip install -r requirements.txt
    python app.py
    # -> http://localhost:5000
"""

import threading
from flask import Flask, request, jsonify

from models import init_db, get_db, insert_or_merge_detection
from geolocation import reverse_geocode

app = Flask(__name__)


@app.after_request
def add_cors_headers(response):
    # The dashboard is served separately (static HTML/JS) and needs
    # cross-origin access to this API. Kept dependency-free (no flask-cors)
    # so the backend has zero extra install requirements beyond Flask itself.
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


@app.route("/api/<path:_any>", methods=["OPTIONS"])
def cors_preflight(_any):
    return "", 204


ALLOWED_STATUSES = {"reported", "acknowledged", "scheduled", "repaired"}
ALLOWED_SEVERITIES = {"minor", "moderate", "severe"}


def background_geocode(detection_id, lat, lon):
    """Fetches the address in the background so the API doesn't block."""
    try:
        address = reverse_geocode(lat, lon)
        if address:
            with get_db() as conn:
                conn.execute(
                    "UPDATE detections SET address = ? WHERE id = ?", 
                    (address, detection_id)
                )
                conn.commit()
    except Exception as e:
        # In a production app, log this error
        print(f"Geocoding failed for detection {detection_id}: {e}")


@app.route("/api/detections", methods=["POST"])
def submit_detection():
    """
    Body:
    {
      "vehicle_id": "bus-042",
      "latitude": 8.5241,
      "longitude": 76.9366,
      "severity": "moderate",
      "est_depth_cm": 3.2,
      "confidence": 0.87,
      "image_ref": "s3://bucket/frame123.jpg"   # optional
    }
    """
    data = request.get_json(force=True, silent=True) or {}

    required = ["vehicle_id", "latitude", "longitude", "severity"]
    missing = [f for f in required if f not in data]
    if missing:
        return jsonify({"error": f"Missing required fields: {missing}"}), 400

    if data["severity"] not in ALLOWED_SEVERITIES:
        return jsonify({"error": f"severity must be one of {sorted(ALLOWED_SEVERITIES)}"}), 400

    try:
        lat = float(data["latitude"])
        lon = float(data["longitude"])
    except (TypeError, ValueError):
        return jsonify({"error": "latitude/longitude must be numeric"}), 400

    # Insert the detection without blocking for the geocoder
    result = insert_or_merge_detection(
        vehicle_id=data["vehicle_id"],
        lat=lat,
        lon=lon,
        severity=data["severity"],
        est_depth_cm=float(data.get("est_depth_cm", 0)),
        confidence=float(data.get("confidence", 0)),
        image_ref=data.get("image_ref"),
        address=None,  # Will be populated in the background
    )

    # Trigger background thread for geocoding if we have a valid ID
    detection_id = result.get("id")
    if detection_id:
        threading.Thread(
            target=background_geocode, 
            args=(detection_id, lat, lon), 
            daemon=True
        ).start()

    status_code = 200 if result.get("merged") else 201
    return jsonify(result), status_code


@app.route("/api/detections", methods=["GET"])
def list_detections():
    """
    Query params:
      severity=minor|moderate|severe   filter by severity
      status=reported|acknowledged...  filter by status
      limit=100                        max rows (default 200)
      offset=0                         pagination offset
    """
    severity = request.args.get("severity")
    status = request.args.get("status")

    # Safely parse limit and offset to avoid 500 errors
    try:
        limit = min(int(request.args.get("limit", 200)), 1000)
    except ValueError:
        return jsonify({"error": "limit must be a valid integer"}), 400

    try:
        offset = int(request.args.get("offset", 0))
    except ValueError:
        return jsonify({"error": "offset must be a valid integer"}), 400

    query = "SELECT * FROM detections WHERE 1=1"
    params = []
    if severity:
        query += " AND severity = ?"
        params.append(severity)
    if status:
        query += " AND status = ?"
        params.append(status)
        
    query += " ORDER BY timestamp DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])

    with get_db() as conn:
        rows = conn.execute(query, params).fetchall()

    return jsonify([dict(r) for r in rows])


@app.route("/api/detections/<detection_id>", methods=["GET"])
def get_detection(detection_id):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM detections WHERE id = ?", (detection_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    return jsonify(dict(row))


@app.route("/api/detections/<detection_id>", methods=["PATCH"])
def update_detection(detection_id):
    """Body: {"status": "acknowledged"} — used by municipal officials via the dashboard."""
    data = request.get_json(force=True, silent=True) or {}
    new_status = data.get("status")
    
    if new_status not in ALLOWED_STATUSES:
        return jsonify({"error": f"status must be one of {sorted(ALLOWED_STATUSES)}"}), 400

    with get_db() as conn:
        cur = conn.execute(
            "UPDATE detections SET status = ? WHERE id = ?", 
            (new_status, detection_id)
        )
        conn.commit()  # Explicitly commit the transaction
        
        if cur.rowcount == 0:
            return jsonify({"error": "not found"}), 404
            
        row = conn.execute("SELECT * FROM detections WHERE id = ?", (detection_id,)).fetchone()

    return jsonify(dict(row))


@app.route("/api/stats", methods=["GET"])
def stats():
    with get_db() as conn:
        total = conn.execute("SELECT COUNT(*) c FROM detections").fetchone()["c"]
        by_severity = conn.execute(
            "SELECT severity, COUNT(*) c FROM detections WHERE status != 'repaired' GROUP BY severity"
        ).fetchall()
        by_status = conn.execute(
            "SELECT status, COUNT(*) c FROM detections GROUP BY status"
        ).fetchall()
        vehicles = conn.execute(
            "SELECT COUNT(DISTINCT vehicle_id) c FROM detections"
        ).fetchone()["c"]

    return jsonify({
        "total_reports": total,
        "active_vehicles": vehicles,
        "open_by_severity": {r["severity"]: r["c"] for r in by_severity},
        "by_status": {r["status"]: r["c"] for r in by_status},
    })


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    init_db()
    import os
    debug_mode = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=5000, debug=debug_mode)