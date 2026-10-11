// bass — the JU-06A from okamnesiac/offset (patches/ju06a.scd) set as the
// bass that patch's factory makes: one saw with the square sub an octave
// below, a resonant filter the envelope opens on each note, a short
// envelope, and no chorus. The chain is the same as juno.scd's: DCO → HPF
// → resonant VCF → VCA. Each program carries its own copy of the graph,
// because a program's own bytes are the cache key for what it renders.
//
// Under FIELD_MODE=voice its value is one voice, gated, which `field keys
// bass` plays and a record entry with `instrument: bass` renders
// (keyboard-instrument.md §2.6). It plays at true pitch, so press Z in
// musical-typing to drop an octave. Otherwise it runs under Field's
// sc-render contract and renders offset's sequence from sessions/juno.scd,
// a note every quarter second as offset plays it, for FIELD_DURATION.
(
var bass = (
	lfoRate: 0.5, lfoDelay: 0, dcoLfo: 0,
	range: 8, sawLevel: 1, pulseLevel: 0, subLevel: 0.5, noiseLevel: 0,
	pwm: 0.5, pwmMode: 0, pwmLfo: 0,
	hpfFreq: 20,
	vcfFreq: 1200, vcfRes: 0.4, vcfEnv: 0.6, vcfLfo: 0, vcfKeyFollow: 0,
	atk: 0.005, dec: 0.2, sus: 0.3, rel: 0.15,
	chorusOn: 0, chorusRate: 0.5, chorusDepth: 0.005
);
var level = 0.3; // a voice's gain: a bass line rarely stacks notes

// One JU-06A voice for the knobs in `k`, stereo, freed when its envelope
// ends after the gate closes. The knobs are fixed per instrument, so they
// shape the graph rather than arriving as controls.
var ju06a = { |freq, gate, k|
	var lfo, pw, sig, env, cutoff;
	lfo = SinOsc.kr(k[\lfoRate]) * EnvGen.kr(Env([0, 0, 1], [k[\lfoDelay], 0.01]));
	freq = freq * (8 / k[\range]) * (2 ** (lfo * k[\dcoLfo] / 12));
	pw = if (k[\pwmMode] == 1) { SinOsc.kr(k[\lfoRate]).range(0.1, 0.9) } { k[\pwm] };
	pw = (pw + (lfo * k[\pwmLfo])).clip(0.05, 0.95);
	sig = (Saw.ar(freq) * k[\sawLevel]) + (Pulse.ar(freq, pw) * k[\pulseLevel]);
	if (k[\subLevel] > 0) { sig = sig + (Pulse.ar(freq * 0.5, 0.5) * k[\subLevel]) };
	if (k[\noiseLevel] > 0) { sig = sig + (WhiteNoise.ar * k[\noiseLevel]) };
	sig = HPF.ar(sig, k[\hpfFreq].clip(20, 20000));
	env = EnvGen.kr(Env.adsr(k[\atk], k[\dec], k[\sus], k[\rel]), gate, doneAction: 2);
	cutoff = k[\vcfFreq] * (1 + (env * k[\vcfEnv]) + (lfo * k[\vcfLfo])) + (freq * k[\vcfKeyFollow]);
	sig = RLPF.ar(sig, cutoff.clip(20, 20000), 1 - k[\vcfRes].clip(0, 0.95)) * env;
	if (k[\chorusOn] == 1) {
		[0, pi].collect { |phase|
			sig + DelayC.ar(sig, 0.05, SinOsc.kr(k[\chorusRate], phase).range(0.001, 0.001 + k[\chorusDepth]))
		} * 0.7
	} {
		sig ! 2
	}
};

if ("FIELD_MODE".getenv == "voice") {
	SynthDef(\bassKey, { |out = 0, freq = 220, amp = 0.5, gate = 1|
		Out.ar(out, ju06a.(freq, gate, bass) * amp * level);
	})
} {
	var seed = "FIELD_SEED".getenv.asInteger;
	var dur = "FIELD_DURATION".getenv.asFloat;
	var rate = "FIELD_SAMPLE_RATE".getenv.asInteger;
	var out = "FIELD_OUTPUT".getenv;
	var chans = "FIELD_CHANNELS".getenv.asInteger;
	var line = [48, 48, 60, 48, 55, 48, 53, 51]; // C3 C3 C4 C3 G3 C3 F3 Eb3
	var step = 0.25; // offset's \dur, at the default clock's one beat a second
	var events = [];
	thisThread.randSeed = seed; // nothing here is random; kept for the contract

	SynthDef(\bassRender, { |freq = 220, amp = 0.5, gate = 1|
		var sig = ju06a.(freq, gate, bass) * amp * level;
		Out.ar(0, if (chans == 1) { sig.sum * 0.5 } { sig });
	}).store;

	(dur / step).floor.asInteger.do { |i|
		var node = 1000 + i;
		var at = i * step;
		events = events.add([at, [\s_new, \bassRender, node, 0, 0, \freq, line.wrapAt(i).midicps, \amp, 0.8]]);
		events = events.add([at + (step * 0.8), [\n_set, node, \gate, 0]]);
	};
	Score(events ++ [[dur, [0]]]).recordNRT(
		outputFilePath: out,
		sampleRate: rate,
		headerFormat: "WAV",
		sampleFormat: "int24",
		options: ServerOptions.new.numOutputBusChannels_(chans),
		duration: dur,
		action: { 0.exit }
	);
}
)
