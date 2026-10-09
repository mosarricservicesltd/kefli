/* Generated from shared/cover/cover-v1.js by shared/cover/build.mjs. Do not edit: cover v1 is frozen, and a change ships as cover-v2. */
/*
 * Shelf cover v1
 * ==============
 * Every save draws its own cover from the sha256 of its normalised URL (the hash in its d tag,
 * contract section 4.3). Same hash in, same picture out, on every device and in every JS engine.
 *
 * FROZEN. Cover v1 is never edited once shipped: a change to any output ships as cover-v2 with a
 * stated migration (see README.md). Golden fixtures: fixtures.json; check: node test.cjs.
 *
 * Extracted from the Fingerprint concept board (docs/design/study/fingerprint.html, the GEN block),
 * with its palettes, leaves and derived inks kept exactly. The SVG differs from the board's in one stated
 * way, the seam rule of 4 October 2026 (see SEAM below and README.md, Drawing). test.cjs proves the
 * equality against the board's own functions, and the SVG equality through that rule.
 *
 * Determinism: no Math.random, Date, locale or timezone. Every decision uses only IEEE-754 double
 * + - * /, comparisons, integer operations, % and Math.floor/round, which ECMAScript defines exactly
 * (no argument mix() gets from lineInk or highlight is 0.49999999999999994, the one value that an
 * engine rounding by floor(x + 0.5), such as Windows' JScript, gets wrong). There is no
 * Math.pow, **, sin, cos or exp anywhere: sRGB transfer runs through two precomputed tables, and
 * OKLCH angles and the signal lightness run through fixed polynomials (FreeBSD msun kernels).
 * Every numeric literal has 17 significant digits or fewer, so every engine parses it to the same
 * double. Geometry is in whole units (1 unit = 100 viewBox px); the only non-integers in the SVG
 * are the bands' thirds, written below as fixed strings.
 *
 * Works as a classic <script> (defines window.ShelfCover) and under require (module.exports).
 * Dependency-free; ES2015.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.ShelfCover = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 'cover-v1';

  /* =====================================================================
     Input
     ===================================================================== */
  const HASH_RE = /^[0-9a-f]{64}$/;
  function checkHash(hash) {
    const h = typeof hash === 'string' ? hash.toLowerCase() : '';
    if (!HASH_RE.test(h)) throw new TypeError('ShelfCover: expected a sha256 as 64 hex characters, got ' + String(hash));
    return h;
  }
  const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
  function checkHex(c) {
    if (typeof c !== 'string' || !HEX_RE.test(c)) throw new TypeError('ShelfCover: expected a colour as #RRGGBB, got ' + String(c));
    return c;
  }
  function checkInt(v, name, lo, hi) {
    if (typeof v !== 'number' || v !== Math.floor(v) || v < lo || v > hi) throw new RangeError('ShelfCover: ' + name + ' must be a whole number from ' + lo + ' to ' + hi);
    return v;
  }
  const byteAt = (hex, i) => parseInt(hex.slice(i, i + 2), 16);
  const DIGITS = '0123456789ABCDEF';
  const hex2 = n => DIGITS.charAt(n >> 4) + DIGITS.charAt(n & 15);

  /* =====================================================================
     sRGB transfer tables (generated once in V8 from the board's formulas)
     ===================================================================== */
  // LIN[c] = the sRGB byte c in linear light: c/255 <= 0.04045 ? (c/255) / 12.92 : ((c/255 + 0.055) / 1.055)^2.4
  const LIN = [
    0, 0.0003035269835488375, 0.000607053967097675, 0.0009105809506465125, 0.00121410793419535, 0.0015176349177441874,
    0.001821161901293025, 0.0021246888848418626, 0.0024282158683907, 0.0027317428519395373, 0.003035269835488375, 0.003346535763899161,
    0.003676507324047436, 0.004024717018496307, 0.004391442037410293, 0.004776953480693729, 0.005181516702338386, 0.005605391624202723,
    0.006048833022857054, 0.006512090792594475, 0.006995410187265387, 0.007499032043226175, 0.008023192985384994, 0.008568125618069307,
    0.009134058702220787, 0.00972121732023785, 0.010329823029626936, 0.010960094006488246, 0.011612245179743885, 0.012286488356915872,
    0.012983032342173012, 0.013702083047289686, 0.014443843596092545, 0.01520851442291271, 0.01599629336550963, 0.016807375752887384,
    0.017641954488384078, 0.018500220128379697, 0.019382360956935723, 0.0202885630566524, 0.021219010376003555, 0.022173884793387385,
    0.02315336617811041, 0.024157632448504756, 0.02518685962736163, 0.026241221894849898, 0.027320891639074894, 0.028426039504420793,
    0.0295568344378088, 0.030713443732993635, 0.03189603307301153, 0.033104766570885055, 0.03433980680868217, 0.03560131487502034,
    0.03688945040110004, 0.0382043715953465, 0.03954623527673284, 0.04091519690685319, 0.042311410620809675, 0.043735029256973465,
    0.04518620438567554, 0.046665086336880095, 0.04817182422688942, 0.04970656598412723, 0.05126945837404324, 0.052860647023180246,
    0.05448027644244237, 0.05612849004960009, 0.05780543019106723, 0.0595112381629812, 0.06124605423161761, 0.06301001765316767,
    0.06480326669290577, 0.06662593864377289, 0.06847816984440017, 0.07036009569659588, 0.07227185068231748, 0.07421356838014963,
    0.07618538148130785, 0.07818742180518633, 0.08021982031446832, 0.0822827071298148, 0.08437621154414882, 0.08650046203654976,
    0.08865558628577294, 0.09084171118340768, 0.09305896284668745, 0.0953074666309647, 0.09758734714186246, 0.09989872824711389,
    0.10224173308810132, 0.10461648409110419, 0.10702310297826761, 0.10946171077829933, 0.1119324278369056, 0.11443537382697373,
    0.11697066775851084, 0.11953842798834562, 0.12213877222960187, 0.12477181756095049, 0.12743768043564743, 0.1301364766903643,
    0.13286832155381798, 0.13563332965520566, 0.13843161503245183, 0.14126329114027164, 0.14412847085805777, 0.14702726649759498,
    0.14995978981060856, 0.15292615199615017, 0.1559264637078274, 0.1589608350608804, 0.162029375639111, 0.1651321945016676,
    0.16826940018969075, 0.1714411007328226, 0.17464740365558504, 0.17788841598362912, 0.18116424424986022, 0.184474994500441,
    0.18782077230067787, 0.19120168274079138, 0.1946178304415758, 0.19806931955994886, 0.20155625379439707, 0.20507873639031693,
    0.20863687014525575, 0.21223075741405523, 0.21586050011389926, 0.2195261997292692, 0.2232279573168085, 0.22696587351009836,
    0.23074004852434915, 0.23455058216100522, 0.238397573812271, 0.24228112246555486, 0.24620132670783548, 0.25015828472995344,
    0.25415209433082675, 0.2581828529215958, 0.26225065752969623, 0.26635560480286247, 0.2704977910130658, 0.27467731206038465,
    0.2788942634768104, 0.2831487404299921, 0.2874408377269175, 0.29177064981753587, 0.2961382707983211, 0.3005437944157765,
    0.3049873140698863, 0.30946892281750854, 0.31398871337571754, 0.31854677812509186, 0.32314320911295075, 0.3277780980565422,
    0.33245153634617935, 0.33716361504833037, 0.3419144249086609, 0.3467040563550296, 0.35153259950043936, 0.3564001441459435,
    0.3613067797835095, 0.3662525955988395, 0.3712376804741491, 0.3762621229909065, 0.38132601143253014, 0.386429433787049,
    0.39157247774972326, 0.39675523072562685, 0.4019777798321958, 0.4072402119017367, 0.41254261348390375, 0.4178850708481375,
    0.4232676699860717, 0.4286904966139066, 0.43415363617474895, 0.4396571738409188, 0.44520119451622786, 0.45078578283822346,
    0.45641102318040466, 0.4620769996544071, 0.467783796112159, 0.47353149614800955, 0.4793201831008268, 0.4851499400560704,
    0.4910208498478356, 0.4969329950608704, 0.5028864580325687, 0.5088813208549338, 0.5149176653765214, 0.5209955732043543,
    0.5271151257058131, 0.5332764040105052, 0.5394794890121072, 0.5457244613701866, 0.5520114015120001, 0.5583403896342679,
    0.5647115057049292, 0.5711248294648731, 0.5775804404296506, 0.5840784178911641, 0.5906188409193369, 0.5972017883637634,
    0.6038273388553378, 0.6104955708078648, 0.6172065624196511, 0.6239603916750761, 0.6307571363461468, 0.6375968739940326,
    0.6444796819705821, 0.6514056374198242, 0.6583748172794485, 0.665387298282272, 0.6724431569576875, 0.6795424696330938,
    0.6866853124353135, 0.6938717612919899, 0.7011018919329731, 0.7083757798916868, 0.7156935005064807, 0.7230551289219693,
    0.7304607400903537, 0.7379104087727308, 0.7454042095403874, 0.7529422167760779, 0.7605245046752924, 0.768151147247507,
    0.7758222183174236, 0.7835377915261935, 0.7912979403326302, 0.799102738014409, 0.8069522576692516, 0.8148465722161012,
    0.8227857543962835, 0.8307698767746546, 0.83879901174074, 0.846873231509858, 0.8549926081242338, 0.8631572134541023,
    0.8713671191987972, 0.8796223968878317, 0.8879231178819663, 0.8962693533742664, 0.9046611743911496, 0.9130986517934192,
    0.9215818562772946, 0.9301108583754237, 0.938685728457888, 0.9473065367331999, 0.9559733532492861, 0.9646862478944651,
    0.9734452903984125, 0.9822505503331171, 0.9911020971138298, 1,
  ];
  // ENC[k - 1] = the smallest linear-light value whose sRGB byte is k (k = 1..255), i.e. where
  // round(255 * encode(v)) steps from k - 1 to k, with encode(v) = v <= 0.0031308 ? 12.92 v : 1.055 v^(1/2.4) - 0.055.
  const ENC = [
    0.00015176349177441873, 0.00045529047532325625, 0.0007588174588720937, 0.0010623444424209313, 0.0013658714259697686, 0.0016693984095186062,
    0.0019729253930674436, 0.002276452376616281, 0.0025799793601651187, 0.0028835063437139563, 0.0031883009044305316, 0.0035092593495812297,
    0.003848314933096426, 0.004205748030104947, 0.00458183274052838, 0.004976837250274023, 0.005391024159806381, 0.005824650784040897,
    0.006277969426914108, 0.006751227633498623, 0.0072446684221289205, 0.007758530498667859, 0.008293048454762328, 0.008848452951698497,
    0.00942497089126609, 0.010022825574869037, 0.010642236851973576, 0.011283421258858298, 0.011946592148522128, 0.012631959812511863,
    0.013339731595349033, 0.014070112002164467, 0.014823302800086414, 0.01559950311387327, 0.016398909516233677, 0.0172217161132341,
    0.018068114625156378, 0.018938294463134074, 0.019832442801866853, 0.02075074464868551, 0.021693382909216234, 0.022660538449872064,
    0.023652390157379497, 0.024669114995532006, 0.025710888059345766, 0.026777882626779784, 0.02787027020816926, 0.028988220593509972,
    0.030131901897720907, 0.03130148060400286, 0.032497121605402225, 0.03371898824468107, 0.03496724235258795, 0.03624204428461638,
    0.037543552956333104, 0.038871925877351575, 0.04022731918402184, 0.04160988767090288, 0.043019784821079404, 0.04445716283538092,
    0.04592217266055745, 0.047414964016462814, 0.04893568542229297, 0.05048448422192487, 0.052061506608397194, 0.05366689764757336,
    0.055300801301023855, 0.056963360448162935, 0.058654716907673536, 0.060375011458250805, 0.06212438385869474, 0.06390297286737924,
    0.06571091626112459, 0.06754835085349804, 0.0694154125125661, 0.07131223617812142, 0.07323895587840541, 0.07519570474634665,
    0.07718261503533433, 0.07919981813454502, 0.0812474445838404, 0.08332562408825163, 0.08543448553206702, 0.08757415699253682,
    0.08974476575321062, 0.09194643831691977, 0.09417930041841838, 0.09644347703669504, 0.09873909240696692, 0.10106627003236779,
    0.10342513269534023, 0.10581580246874268, 0.10823840072668098, 0.11069304815507362, 0.11317986476196007, 0.1156989698875601,
    0.1182504822140934, 0.12083451977536605, 0.12345119996613246, 0.12610063955123937, 0.12878295467455939, 0.13149826086772046,
    0.1342466730586372, 0.13702830557985107, 0.13984327217668513, 0.14269168601521826, 0.1455736596900856, 0.1484893052321087,
    0.15143873411576272, 0.1544220572664832, 0.1574393850678189, 0.1604908273684337, 0.16357649348896341, 0.16669649222873034,
    0.16985093187232053, 0.17303992019602685, 0.1762635644741625, 0.17952197148524757, 0.18281524751807332, 0.18614349837764563,
    0.18950682939101376, 0.1929053454129845, 0.1963391508317269, 0.19980834957426885, 0.20331304511189063, 0.20685334046541498,
    0.21042933821039972, 0.21404114048223252, 0.2176888489811322, 0.22137256497705876, 0.22509238931453274, 0.228848422417369,
    0.2326407642933246, 0.236469514538663, 0.2403347723426401, 0.24423663649190827, 0.24817520537484555, 0.2521505769858089,
    0.25616284892931374, 0.2602121184241434, 0.26429848230738656, 0.2684220370384083, 0.2725828787027535, 0.27678110301598524,
    0.28101680532745965, 0.2852900806240389, 0.2896010235337422, 0.2939497283293396, 0.29833628893188446, 0.3027607989141933,
    0.3072233515042662, 0.3117240395886551, 0.31626295571577845, 0.32084019209918363, 0.32545584062075916, 0.3301099928338966,
    0.334802739966603, 0.3395341729245683, 0.3443043822941826, 0.34911345834551083, 0.3539614910352207, 0.358848570009467,
    0.3637747846067349, 0.36874022386063815, 0.37374497650267885, 0.37878913096496586, 0.38387277538289255, 0.3889959975977784,
    0.3941588851594697, 0.39936152532890534, 0.40460400508064537, 0.40988641110536284, 0.4152088298123019, 0.42057134733170154,
    0.42597404951718393, 0.43141702194811216, 0.4369003499319129, 0.44242411850636965, 0.4479884124418832, 0.45359331624370164,
    0.4592389141541209, 0.46492529015465517, 0.47065252796817914, 0.47642071106104084, 0.48222992264514675, 0.48808024568002045,
    0.4939717628748329, 0.4999045566904079, 0.5058787093411998, 0.5118943027972471, 0.5179514187861014, 0.5240501387947288,
    0.5301905440713919, 0.5363727156275037, 0.5425967342394598, 0.5488626804504493, 0.5551706345722394, 0.5615206766869423,
    0.5679128866487574, 0.5743473440856917, 0.580824128401262, 0.5873433187761736, 0.5939049941699805, 0.600509233322725,
    0.6071561147565557, 0.6138457167773311, 0.6205781174761988, 0.6273533947311589, 0.634171626208609, 0.6410328893648692,
    0.647937261447692, 0.6548848194977529, 0.6618756403501224, 0.6689098006357259, 0.6759873767827809, 0.6831084450182222,
    0.6902730813691093, 0.6974813616640164, 0.7047333615344106, 0.7120291564160103, 0.7193688215501312, 0.726752431985017,
    0.7341800625771541, 0.7416517879925734, 0.7491676827081359, 0.7567278210128071, 0.7643322770089146, 0.771981124613393,
    0.7796744375590167, 0.7874122893956172, 0.7951947534912903, 0.8030219030335869, 0.8108938110306932, 0.8188105503125997,
    0.826772193532254, 0.8347788131667059, 0.842830481518237, 0.8509272707154807, 0.8590692527145302, 0.8672564993000342,
    0.8754890820862817, 0.8837670725182771, 0.8920905418728015, 0.9004595612594655, 0.9088742016217515, 0.9173345337380437,
    0.9258406282226488, 0.9343925555268067, 0.9429903859396902, 0.9516341895893965, 0.9603240364439273, 0.9690599963121591,
    0.9778421388448046, 0.9866705335353665, 0.9955452497210778,
  ];
  // linear light -> sRGB byte, clamped to 0..255 (the number of thresholds at or below v)
  function encode(v) {
    let lo = 0, hi = 255;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ENC[m - 1] <= v) lo = m; else hi = m - 1; }
    return lo;
  }

  /* =====================================================================
     Fixed polynomials (only + - * /)
     ===================================================================== */
  // FreeBSD msun k_sin.c and k_cos.c, valid on |x| <= pi/4; y is the tail of a reduced argument.
  const S1 = -0.16666666666666632, S2 = 0.00833333333332249, S3 = -0.0001984126982985795,
        S4 = 0.0000027557313707070068, S5 = -2.5050760253406863e-8, S6 = 1.58969099521155e-10;
  const C1 = 0.0416666666666666, C2 = -0.001388888888887411, C3 = 0.00002480158728947673,
        C4 = -2.7557314351390663e-7, C5 = 2.087572321298175e-9, C6 = -1.1359647557788195e-11;
  function ksin(x, y, iy) {
    const z = x * x, w = z * z, r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6), v = z * x;
    return iy === 0 ? x + v * (S1 + z * r) : x - ((z * (0.5 * y - v * r) - y) - v * S1);
  }
  function kcos(x, y) {
    const z = x * x;
    let w = z * z;
    const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
    const hz = 0.5 * z;
    w = 1 - hz;
    return w + (((1 - w) - hz) + (z * r - x * y));
  }
  // pi/2 in three parts for Cody-Waite reduction (fdlibm e_rem_pio2.c)
  const PI = 3.141592653589793, PIO4 = 0.7853981633974483, INVPIO2 = 0.6366197723675814,
        PIO2_1 = 1.5707963267341256, PIO2_1T = 6.077100506506192e-11,
        PIO2_2 = 6.077100506303966e-11, PIO2_2T = 2.0222662487959506e-21,
        PIO2_3 = 2.0222662487111665e-21, PIO2_3T = 8.4784276603689e-32;
  // binary exponent of a finite double, by exact halving and doubling
  function expo(v) {
    if (v < 0) v = -v;
    if (v === 0) return -1100;
    let e = 0;
    while (v >= 2) { v /= 2; e++; }
    while (v < 1) { v *= 2; e--; }
    return e;
  }
  // [sin, cos] of an angle in degrees, 0 <= deg < 360. The radians are formed as the board forms
  // them, (deg * PI) / 180, then reduced by multiples of pi/2.
  function sincos(deg) {
    const x = deg * PI / 180;
    if (x <= PIO4) return [ksin(x, 0, 0), kcos(x, 0)];
    const n = (x * INVPIO2 + 0.5) | 0, fn = n;
    let r = x - fn * PIO2_1, w = fn * PIO2_1T, y0 = r - w;
    const j = expo(x);
    if (j - expo(y0) > 16) {
      let t = r; w = fn * PIO2_2; r = t - w; w = fn * PIO2_2T - ((t - r) - w); y0 = r - w;
      if (j - expo(y0) > 49) { t = r; w = fn * PIO2_3; r = t - w; w = fn * PIO2_3T - ((t - r) - w); y0 = r - w; }
    }
    const y1 = (r - y0) - w;
    const s = ksin(y0, y1, 1), c = kcos(y0, y1);
    switch (n & 3) {
      case 0: return [s, c];
      case 1: return [c, -s];
      case 2: return [-s, -c];
      default: return [-c, s];
    }
  }
  // e^x for -700 < x <= 0 (FreeBSD msun e_exp.c, bit for bit)
  const HALF_LN2 = 0.3465735912322998, ONEHALF_LN2 = 1.0397205352783203, TINY = 3.725290298461914e-9,
        LN2HI = 0.6931471803691238, LN2LO = 1.9082149292705877e-10, INVLN2 = 1.4426950408889634,
        P1 = 0.16666666666666602, P2 = -0.0027777777777015593, P3 = 0.00006613756321437934,
        P4 = -0.0000016533902205465252, P5 = 4.1381367970572385e-8;
  function expNeg(x) {
    let hi = 0, lo = 0, k = 0;
    const ax = -x;
    if (ax >= HALF_LN2) {
      if (ax < ONEHALF_LN2) { hi = x + LN2HI; lo = -LN2LO; k = -1; }
      else { k = (INVLN2 * x - 0.5) | 0; const t = k; hi = x - t * LN2HI; lo = t * LN2LO; }
      x = hi - lo;
    } else if (ax < TINY) return 1 + x;
    const t = x * x;
    let twopk = 1;
    for (let i = 0; i < -k; i++) twopk *= 0.5;
    const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if (k === 0) return 1 - ((x * c) / (c - 2) - x);
    return (1 - ((lo - (x * c) / (2 - c)) - hi)) * twopk;
  }

  /* =====================================================================
     OKLCH -> sRGB hex
     ===================================================================== */
  function oklabToLinear(L, a, b) {
    let l = L + 0.3963377774 * a + 0.2158037573 * b;
    let m = L - 0.1055613458 * a - 0.0638541728 * b;
    let s = L - 0.0894841775 * a - 1.2914855480 * b;
    l = l * l * l; m = m * m * m; s = s * s * s;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
           -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
           -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  }
  const inGamut = rgb => rgb[0] >= -1e-4 && rgb[0] <= 1 + 1e-4 && rgb[1] >= -1e-4 && rgb[1] <= 1 + 1e-4 && rgb[2] >= -1e-4 && rgb[2] <= 1 + 1e-4;
  // chroma is reduced (18 halvings) until the colour fits sRGB; hue and lightness are kept
  function oklch(L, C, h) {
    const sc = sincos(((h % 360) + 360) % 360), cs = sc[1], sn = sc[0];
    let lo = 0, hi = C, rgb = oklabToLinear(L, C * cs, C * sn);
    if (!inGamut(rgb)) {
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2, t = oklabToLinear(L, mid * cs, mid * sn);
        if (inGamut(t)) lo = mid; else hi = mid;
      }
      rgb = oklabToLinear(L, lo * cs, lo * sn);
    }
    return '#' + hex2(encode(rgb[0])) + hex2(encode(rgb[1])) + hex2(encode(rgb[2]));
  }

  /* =====================================================================
     Palette: bytes 0-3
     ===================================================================== */
  // signal lightness follows hue so yellows stay yellow and blues stay deep: 0.63 + 0.17 e^-((d/38)^2),
  // d = the hue's distance from 100 degrees
  function signalL(hue) {
    const a = hue - 100 < 0 ? 100 - hue : hue - 100;
    const d = a < 360 - a ? a : 360 - a;
    const q = d / 38;
    return 0.63 + 0.17 * expNeg(-(q * q));
  }
  const SCHEMES = [['analogous', 38, -34], ['complement', 180, 26], ['triad', 120, 240], ['split', 150, 210]];
  const DARK_BELOW = 80;                         // byte 3 below 80: a dark ground, about three covers in ten
  const cache = new Map();
  function palette(hash) {
    hash = checkHash(hash);
    const hit = cache.get(hash);
    if (hit) return hit;
    const hue = ((byteAt(hash, 0) << 8) | byteAt(hash, 2)) / 65536 * 360;
    const sch = SCHEMES[byteAt(hash, 4) & 3];
    const dark = byteAt(hash, 6) < DARK_BELOW;
    const h1 = hue + sch[1], h2 = hue + sch[2];
    const signal = oklch(signalL(hue), 0.175, hue);
    const p = dark
      ? { ground: oklch(0.255, 0.045, h2), deep: oklch(0.93, 0.035, h1), soft: oklch(0.60, 0.12, h1), signal: signal }
      : { ground: oklch(0.945, 0.028, h2), deep: oklch(0.33, 0.085, h1), soft: oklch(0.81, 0.095, h1), signal: signal };
    p.hue = Math.round(hue); p.scheme = sch[0]; p.dark = dark; p.hash = hash;
    Object.freeze(p);
    if (cache.size >= 4096) cache.clear();
    cache.set(hash, p);
    return p;
  }

  /* =====================================================================
     Composition: sfc32 seeded from bytes 4-19
     ===================================================================== */
  function rng(hash) {
    const w = i => parseInt(hash.slice(8 + i * 8, 16 + i * 8), 16) | 0;
    let a = w(0), b = w(1), c = w(2), d = w(3);
    const next = () => {
      a |= 0; b |= 0; c |= 0; d |= 0;
      const t = (((a + b) | 0) + d) | 0;
      d = (d + 1) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
    for (let i = 0; i < 12; i++) next();
    return next;
  }
  function pick(r, items) {
    let tot = 0;
    for (let i = 0; i < items.length; i++) tot += items[i][1];
    let v = r() * tot;
    for (let i = 0; i < items.length; i++) { if ((v -= items[i][1]) < 0) return items[i][0]; }
    return items[items.length - 1][0];
  }
  const BIG = [['quarter', 5], ['bands', 2], ['half', 2], ['disc', 2], ['lens', 2], ['ring', 1], ['diag', 1]];
  const SMALL = [['quarter', 4], ['solid', 3], ['diag', 2], ['dot', 2], ['half', 2], ['disc', 1], ['lens', 1]];
  const SPLIT = [0.86, 0.46, 0.24];
  const BG_TOP = [['ground', 6], ['deep', 2], ['soft', 2], ['signal', 1]];       // leaves at depth 0 and 1
  const BG_LOW = [['ground', 8], ['deep', 2], ['soft', 2], ['signal', 1]];       // depth 2 and 3
  const FG = [['signal', 4], ['deep', 3], ['soft', 3], ['ground', 2]];
  const MAX_DEPTH = 3;
  // A root square is 8 x 8 units; leaves are 8, 4, 2 or 1 units across. Returns one leaf list per root.
  function layout(hash, cols, maxDepth) {
    const r = rng(hash), roots = [];
    for (let j = 0; j < cols; j++) {
      const leaves = [];
      const node = (x, y, s, d) => {
        if (d < maxDepth && r() < SPLIT[d]) {
          const h = s / 2;
          node(x, y, h, d + 1); node(x + h, y, h, d + 1); node(x, y + h, h, d + 1); node(x + h, y + h, h, d + 1);
          return;
        }
        const mod = pick(r, s >= 4 ? BIG : SMALL);
        const bg = pick(r, d <= 1 ? BG_TOP : BG_LOW);
        const fg = pick(r, FG.filter(e => e[0] !== bg));
        leaves.push({ x: x + j * 8, y: y, s: s, d: d, mod: mod, rot: Math.floor(r() * 4), bg: bg, fg: fg });
      };
      node(0, 0, 8, 0);
      // every square has one loud shape: the largest leaf (the first, on a tie) carries the signal ink
      let big = leaves[0];
      for (let i = 1; i < leaves.length; i++) if (leaves[i].s > big.s) big = leaves[i];
      if (big.bg !== 'signal' && big.fg !== 'signal') { big.fg = 'signal'; if (big.mod === 'solid' || big.mod === 'dot') big.mod = 'quarter'; }
      roots.push(leaves);
    }
    return roots;
  }
  function readOpts(opts) {
    const o = opts || {};
    return {
      cols: o.cols == null ? 1 : checkInt(o.cols, 'cols', 1, 16),
      depth: o.depth == null ? MAX_DEPTH : checkInt(o.depth, 'depth', 0, MAX_DEPTH),
    };
  }
  // the leaves in drawing order: [{x, y, s, d, mod, rot, bg, fg}], x, y and s in units
  function leaves(hash, opts) {
    hash = checkHash(hash);
    const o = readOpts(opts), out = [];
    const roots = layout(hash, o.cols, o.depth);
    for (let j = 0; j < roots.length; j++) for (let i = 0; i < roots[j].length; i++) out.push(roots[j][i]);
    return out;
  }

  /* =====================================================================
     Drawing: SVG (the same leaf list feeds Skia on the phone)
     ===================================================================== */
  const U = 100;                                 // 1 unit = 100 viewBox px
  // the bands' thirds, as the board writes them (bands only occur on leaves of 4 or 8 units)
  const THIRDS = { 400: ['266.6666666666667', '133.33333333333334'], 800: ['533.3333333333334', '266.6666666666667'] };
  function shape(l, P) {
    const s = l.s * U, fg = P[l.fg], bg = P[l.bg], hs = s / 2;
    switch (l.mod) {
      case 'quarter': return '<path fill="' + fg + '" d="M0 0H' + s + 'A' + s + ' ' + s + ' 0 0 1 0 ' + s + 'Z"/>';
      case 'bands': {
        const t2 = THIRDS[s][0], t1 = THIRDS[s][1];
        return '<path fill="' + fg + '" d="M0 0H' + s + 'A' + s + ' ' + s + ' 0 0 1 0 ' + s + 'Z"/>' +
               '<path fill="' + bg + '" d="M0 0H' + t2 + 'A' + t2 + ' ' + t2 + ' 0 0 1 0 ' + t2 + 'Z"/>' +
               '<path fill="' + fg + '" d="M0 0H' + t1 + 'A' + t1 + ' ' + t1 + ' 0 0 1 0 ' + t1 + 'Z"/>';
      }
      case 'half': return '<path fill="' + fg + '" d="M0 0H' + s + 'A' + hs + ' ' + hs + ' 0 0 1 0 0Z"/>';
      case 'diag': return '<path fill="' + fg + '" d="M0 0H' + s + 'L0 ' + s + 'Z"/>';
      case 'disc': return '<circle fill="' + fg + '" cx="' + hs + '" cy="' + hs + '" r="' + hs + '"/>';
      case 'ring': return '<circle fill="' + fg + '" cx="' + hs + '" cy="' + hs + '" r="' + hs + '"/><circle fill="' + bg + '" cx="' + hs + '" cy="' + hs + '" r="' + (s / 4) + '"/>';
      case 'dot': return '<circle fill="' + fg + '" cx="' + hs + '" cy="' + hs + '" r="' + (s / 5) + '"/>';
      case 'lens': return '<path fill="' + fg + '" d="M' + s + ' 0A' + s + ' ' + s + ' 0 0 1 0 ' + s + 'A' + s + ' ' + s + ' 0 0 1 ' + s + ' 0Z"/>';
      default: return '';                         // solid: the leaf is its background square alone
    }
  }
  // Seams (4 October 2026). Where two leaves meet, antialiasing lets a faint line of whatever lies under
  // them show through, even between shapes of one colour. So every leaf fills its own square, ground
  // included, SEAM px oversize to the right and below (the leaves there are drawn later and cover it),
  // and after its module paints a strip SEAM px either side of its cell's edge along every stretch of
  // the edge the module touches, in the colour touching it. The module itself is drawn exactly as the
  // board draws it. Before rotation a module only touches the top and left sides; the diagonal's strips
  // are cut along its diagonal so that they add nothing inside the cell.
  const SEAM = 2;
  function strips(l, P) {
    const s = l.s * U, fg = P[l.fg], n = -SEAM, p = SEAM;
    const top = (a, b) => 'M' + a + ' ' + n + 'H' + b + 'V' + p + 'H' + a + 'Z';
    const left = (a, b) => 'M' + n + ' ' + a + 'H' + p + 'V' + b + 'H' + n + 'Z';
    switch (l.mod) {
      case 'quarter': return '<path fill="' + fg + '" d="' + top(0, s) + left(0, s) + '"/>';
      case 'half': return '<path fill="' + fg + '" d="' + top(0, s) + '"/>';
      case 'diag': return '<path fill="' + fg + '" d="M0 ' + n + 'H' + s + 'V0L' + (s - p) + ' ' + p + 'H0Z' +
                          'M' + n + ' 0H' + p + 'V' + (s - p) + 'L0 ' + s + 'H' + n + 'Z"/>';
      case 'bands': {
        const t2 = THIRDS[s][0], t1 = THIRDS[s][1];
        return '<path fill="' + fg + '" d="' + top(0, t1) + top(t2, s) + left(0, t1) + left(t2, s) + '"/>' +
               '<path fill="' + P[l.bg] + '" d="' + top(t1, t2) + left(t1, t2) + '"/>';
      }
      default: return '';                         // disc, ring, dot and lens touch the edge only at points; solid is its square
    }
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));

  /* the grey cover: same shapes, the chrome's greys, for a save whose text couldn't be fetched */
  const GREY = Object.freeze({
    light: Object.freeze({ ground: '#E4E2DC', soft: '#CFCCC4', signal: '#A9A69F', deep: '#8C8A83' }),
    dark: Object.freeze({ ground: '#29292D', soft: '#3A3A3E', signal: '#55545A', deep: '#7A7983' }),
  });

  // opts: size (px; sets width and height, else the SVG fills its box), depth (0-3, default 3),
  // cols (root squares across, default 1; wider frames continue the cover to the right),
  // grey ('light' | 'dark' | null), draw (wrap each leaf in the draw-in hook), title (accessible name;
  // without one the cover is decorative and hidden from screen readers)
  function svg(hash, opts) {
    hash = checkHash(hash);
    const o = opts || {}, lo = readOpts(o);
    let P;
    if (o.grey == null || o.grey === false) P = palette(hash);
    else if (o.grey === 'light' || o.grey === 'dark') P = GREY[o.grey];
    else throw new RangeError("ShelfCover: grey must be 'light', 'dark' or null");
    const roots = layout(hash, lo.cols, lo.depth);
    const W = lo.cols * 8 * U, H = 8 * U;
    let n = 0, body = '';
    for (let j = 0; j < roots.length; j++) for (let i = 0; i < roots[j].length; i++) {
      const l = roots[j][i], s = l.s * U;
      const rect = '<rect fill="' + P[l.bg] + '" width="' + (s + SEAM) + '" height="' + (s + SEAM) + '"/>';
      const inner = rect + '<g transform="rotate(' + (l.rot * 90) + ' ' + (s / 2) + ' ' + (s / 2) + ')">' + shape(l, P) + strips(l, P) + '</g>';
      body += '<g transform="translate(' + (l.x * U) + ' ' + (l.y * U) + ')">' + (o.draw ? '<g class="lf" style="--i:' + n + '">' + inner + '</g>' : inner) + '</g>';
      n++;
    }
    const size = o.size == null ? '' : (checkInt(o.size, 'size', 1, 4096), ' width="' + (o.size * lo.cols) + '" height="' + o.size + '"');
    const a11y = o.title == null || o.title === '' ? 'aria-hidden="true" focusable="false">' : 'role="img" focusable="false"><title>' + esc(o.title) + '</title>';
    return '<svg' + size + ' viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" ' + a11y +
      '<g ><rect width="' + W + '" height="' + H + '" fill="' + P.ground + '"/>' + body + '</g></svg>';
  }

  /* =====================================================================
     Contrast (WCAG 2), through the LIN table
     ===================================================================== */
  function luminance(c) {
    checkHex(c);
    return 0.2126 * LIN[byteAt(c, 1)] + 0.7152 * LIN[byteAt(c, 3)] + 0.0722 * LIN[byteAt(c, 5)];
  }
  function contrast(a, b) {
    const x = luminance(a), y = luminance(b);
    return ((x > y ? x : y) + 0.05) / ((x < y ? x : y) + 0.05);
  }
  // a + (b - a) t, per sRGB byte, in sRGB space as the board mixes
  function mix(a, b, t) {
    checkHex(a); checkHex(b);
    let out = '#';
    for (let i = 1; i < 7; i += 2) out += hex2(Math.round((byteAt(a, i) / 255 * (1 - t) + byteAt(b, i) / 255 * t) * 255));
    return out;
  }

  /* =====================================================================
     The article's colour in the chrome
     ===================================================================== */
  // the chrome's text colours (tokens: text, light and dark), used only when a caller passes no text colour
  const TEXT_ON = { light: '#17171A', dark: '#EDECE8' };
  // The ink an article lends to its progress line, link underline and countdown: the first of its inks
  // with 3:1 on the surface; failing that, the signal mixed toward the text colour in ten steps of 0.1
  // (accumulated, so the last is 0.9999999999999999) until one clears 3:1; failing that, the text colour.
  function lineInk(hash, surface, text) {
    const P = palette(hash);
    const light = luminance(surface) > 0.4;
    const fb = text == null ? (light ? TEXT_ON.light : TEXT_ON.dark) : checkHex(text);
    // on dark surfaces a light cover lists soft twice, as the board does; the repeat never changes the result
    const order = light ? [P.signal, P.dark ? P.ground : P.deep, P.soft] : [P.signal, P.soft, P.dark ? P.deep : P.soft];
    for (let i = 0; i < order.length; i++) if (contrast(order[i], surface) >= 3) return order[i];
    for (let t = 0.1; t <= 1; t += 0.1) { const c = mix(P.signal, fb, t); if (contrast(c, surface) >= 3) return c; }
    return fb;
  }
  // The spoken-word highlight: the signal washed into the page, as strong as it can be while the text
  // on it keeps 7:1. t starts at 0.34 and loses 0.02 while it stays above 0.04: fifteen steps from 34%
  // to 6% (the next value, 0.039999999999999994, fails the test, so 4% is never tried). If none
  // qualifies, the 6% tint is returned unchecked.
  // reading: {bg, text} or [bg, text]; or call as highlight(hash, bg, text).
  function highlight(hash, reading, text) {
    let bg, tx;
    if (Array.isArray(reading)) { bg = reading[0]; tx = reading[1]; }
    else if (reading && typeof reading === 'object') { bg = reading.bg; tx = reading.text; }
    else { bg = reading; tx = text; }
    checkHex(bg); checkHex(tx);
    const P = palette(hash);
    for (let t = 0.34; t > 0.04; t -= 0.02) { const c = mix(bg, P.signal, t); if (contrast(tx, c) >= 7) return c; }
    return mix(bg, P.signal, 0.06);
  }
  // The Night reading palette, tinted with the article's hue (whole degrees): each article reads on its
  // own dark paper. line and hl are lineInk and highlight on that paper.
  function night(hash) {
    const P = palette(hash), h = P.hue;
    const bg = oklch(0.215, 0.022, h), text = oklch(0.905, 0.012, h), muted = oklch(0.745, 0.022, h);
    return Object.freeze({ bg: bg, text: text, muted: muted, line: lineInk(hash, bg, muted), hl: highlight(hash, bg, text) });
  }

  /* =====================================================================
     Draw-in hooks
     ===================================================================== */
  // svg(hash, {draw: true}) wraps leaf n in <g class="lf" style="--i:n">; this CSS animates it. A container
  // with class "loop" repeats the drawing (used while the text is being fetched). Reduced motion: drawn at once.
  const motion = Object.freeze({
    once: Object.freeze({ durationMs: 520, staggerMs: 34, easing: Object.freeze([0.2, 0.8, 0.2, 1]), fromScale: 0.3, fromOpacity: 0 }),
    loop: Object.freeze({ periodMs: 4400, staggerMs: 42, easing: Object.freeze([0.2, 0.8, 0.2, 1]),
      keyframes: Object.freeze([[0, 0, 0.3], [0.11, 1, 1], [0.82, 1, 1], [0.93, 0, 0.85], [1, 0, 0.85]]) }), // [offset, opacity, scale]
  });
  const css =
    '.lf{transform-box:fill-box;transform-origin:center;animation:drawin .52s cubic-bezier(.2,.8,.2,1) both;animation-delay:calc(var(--i) * 34ms)}' +
    '@keyframes drawin{from{opacity:0;transform:scale(.3)}}' +
    '.loop .lf{animation:drawloop 4.4s cubic-bezier(.2,.8,.2,1) infinite both;animation-delay:calc(var(--i) * 42ms)}' +
    '@keyframes drawloop{0%{opacity:0;transform:scale(.3)}11%,82%{opacity:1;transform:none}93%,100%{opacity:0;transform:scale(.85)}}' +
    '@media (prefers-reduced-motion:reduce){.lf,.loop .lf{animation:none!important}}';

  return Object.freeze({
    version: VERSION,
    palette: palette,
    leaves: leaves,
    svg: svg,
    lineInk: lineInk,
    highlight: highlight,
    night: night,
    contrast: contrast,
    luminance: luminance,
    mix: mix,
    grey: GREY,
    motion: motion,
    css: css,
  });
});
