/**
 * Low-altitude light pollution integrated along the view ray, in Takram's
 * ECEF frame (kilometres, local spherical ground). It samples the existing
 * satellite emission map: no light objects, extra targets, or shadow passes.
 * Clipping to an 8 km shell keeps space and the upper sky dark. The scene's
 * depth bounds the integral, so a foreground building hides the dome behind it.
 */
export const CITY_ATMOSPHERE_SHADER = /* glsl */ `
uniform sampler2D cityEmissionMap;
uniform float cityAtmosphereOn;
uniform float cityAtmosphereSamples;
uniform float cityHaze;
uniform vec3 cityPosition;
uniform vec3 citySun;
uniform float cityRadius;

float cityEmissionAt(const vec3 p) {
  float lon = atan(p.y, p.x);
  // ECEF latitude is geocentric; the satellite map is geodetic (a ~20 km
  // offset at Seattle's latitude if the ellipsoid correction is omitted).
  float lat = atan(p.z, length(p.xy) * (1.0 - 0.00669438));
  vec2 uv = vec2(lon / 6.2831853 + 0.5, 0.5 - lat / 3.14159265);
  float value = texture(cityEmissionMap, uv).r;
  return pow(smoothstep(0.12, 0.85, value), 1.6);
}

vec3 cityAtmosphere(const vec3 direction, const float sceneDistance) {
  if (cityAtmosphereOn <= 0.0) return vec3(0.0);
  vec3 origin = cityPosition;
  float b = dot(origin, direction);
  float radius = cityRadius + 8.0;
  float discriminant = b * b - dot(origin, origin) + radius * radius;
  if (discriminant <= 0.0) return vec3(0.0);
  float root = sqrt(discriminant);
  float start = max(0.0, -b - root);
  float end = min(sceneDistance, -b + root);
  // The sky ray also stops at Earth even if terrain hasn't streamed in yet.
  float groundD = b * b - dot(origin, origin) + cityRadius * cityRadius;
  if (groundD > 0.0 && -b - sqrt(groundD) > 0.0) end = min(end, -b - sqrt(groundD));
  end = min(end, start + 100.0);
  if (end <= start) return vec3(0.0);
  float optical = 0.0;
  float emission = 0.0;
  float count = cityAtmosphereSamples;
  // Quadratic placement gives nearby haze finer sampling, with deterministic
  // positions to avoid temporal noise and preserve stable city silhouettes.
  for (int i = 0; i < 10; ++i) {
    if (float(i) >= count) break;
    float a = float(i) / count;
    float z = (float(i) + 1.0) / count;
    float distance = start + (end - start) * (a * a + z * z) * 0.5;
    float stepLength = (end - start) * (z * z - a * a);
    vec3 point = origin + direction * distance;
    float height = max(0.0, length(point) - cityRadius);
    float night = smoothstep(0.02, -0.12, dot(normalize(point), citySun));
    float density = exp(-height / 1.25) * cityHaze * night;
    float stepOptical = density * stepLength * 0.018;
    float source = cityEmissionAt(point) * exp(-height / 2.2);
    emission += exp(-optical) * (1.0 - exp(-stepOptical)) * source;
    optical += stepOptical;
  }
  // Warm-white LEDs and amber fixtures mix into a subdued warm dome.
  return vec3(1.0, 0.69, 0.39) * emission * 0.0035 * cityAtmosphereOn;
}
`
