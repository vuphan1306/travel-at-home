#include <metal_stdlib>
using namespace metal;

// Phải khớp từng byte với struct Uniforms trong Renderer.swift (chỉ dùng float4 và float4x4 để tránh lệch căn lề).
struct Uniforms {
    float4x4 rot;     // máy -> toạ độ ảnh 360° (chỉ dùng phần 3x3)
    float4 p0;        // tan nửa góc ngang, tan nửa góc dọc, tiến độ chuyển cảnh (0..1), tỉ lệ rộng/cao
    float4 p1;        // zoom, ngưỡng dưới, ngưỡng trên, mức nhuộm màu theo nền
    float4 tint;      // màu nhuộm (rgb), cờ xem mặt nạ
};

struct VOut {
    float4 pos [[position]];
    float2 uv;        // toạ độ ảnh, gốc trên trái
    float2 p;         // toạ độ màn hình -1..1, trục y hướng lên
};

vertex VOut vmain(uint vid [[vertex_id]]) {
    const float2 pts[4] = { float2(-1.0, -1.0), float2(1.0, -1.0), float2(-1.0, 1.0), float2(1.0, 1.0) };
    float2 q = pts[vid];
    VOut o;
    o.pos = float4(q, 0.0, 1.0);
    o.p = q;
    o.uv = float2(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5);
    return o;
}

static float3 samplePano(texture2d<float> pano, float3 d) {
    constexpr sampler rep(filter::linear, s_address::repeat, t_address::clamp_to_edge);
    const float PI = 3.14159265359;
    float lon = atan2(d.x, d.y);
    float lat = asin(clamp(d.z, -1.0, 1.0));
    return pano.sample(rep, float2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI)).rgb;
}

fragment float4 fmain(VOut in [[stage_in]],
                      constant Uniforms &u [[buffer(0)]],
                      texture2d<float> cam [[texture(0)]],
                      texture2d<float> mask [[texture(1)]],
                      texture2d<float> pano [[texture(2)]]) {
    constexpr sampler lin(filter::linear, address::clamp_to_edge);
    float zoom = u.p1.x, lo = u.p1.y, hi = u.p1.z, tintAmt = u.p1.w;
    float reveal = u.p0.z, aspect = u.p0.w;

    // Zoom số: cắt vào giữa ảnh camera.
    float2 zuv = (in.uv - 0.5) / zoom + 0.5;
    float3 raw = cam.sample(lin, zuv).rgb;
    float m = mask.sample(lin, zuv).r;
    // Mặt nạ của Apple đã là độ trong suốt thật nên giữ dạng đường thẳng, chỉ cắt bỏ hai đầu nhiễu.
    float a = clamp((m - lo) / (hi - lo), 0.0, 1.0);

    // Khử viền màu phòng: dải mép mỏng mượn màu từ phía trong thân người.
    float3 fg = raw;
    if (a > 0.003 && a < 0.9) {
        float2 px = float2(1.0 / float(mask.get_width()), 1.0 / float(mask.get_height())) * 1.5;
        float2 g = float2(mask.sample(lin, zuv + float2(px.x, 0.0)).r - mask.sample(lin, zuv - float2(px.x, 0.0)).r,
                          mask.sample(lin, zuv + float2(0.0, px.y)).r - mask.sample(lin, zuv - float2(0.0, px.y)).r);
        float gn = length(g);
        if (gn > 0.02) {
            float3 inner = cam.sample(lin, zuv + g / gn * px * 1.5).rgb;
            fg = mix(inner, raw, smoothstep(0.2, 0.9, a));
        }
    }

    // Tia nhìn của camera trước (ảnh thật, không lật gương): bên phải ảnh là trục -X của máy.
    float3x3 R = float3x3(u.rot[0].xyz, u.rot[1].xyz, u.rot[2].xyz);
    float3 dir = normalize(R * float3(-in.p.x * u.p0.x, in.p.y * u.p0.y, 1.0));
    float3 bg = samplePano(pano, dir);

    float3 person = mix(fg, fg * u.tint.rgb, tintAmt);
    float3 comp = mix(bg, person, a);

    // Hiệu ứng búng tay: vòng sáng lan từ giữa ra.
    float r = length(float2(in.p.x * aspect, in.p.y));
    float edge = reveal * (length(float2(aspect, 1.0)) + 0.35);
    float k = 1.0 - smoothstep(edge - 0.25, edge, r);
    float glow = (1.0 - smoothstep(0.0, 0.14, abs(r - edge))) * step(0.001, reveal) * (1.0 - step(0.999, reveal));
    float3 col = mix(raw, comp, k) + glow * float3(1.0, 0.93, 0.75) * 0.9;

    if (u.tint.w > 0.5) { col = mix(float3(1.0, 0.0, 1.0), fg, a); }   // xem mặt nạ: nền tím
    return float4(col, 1.0);
}
