// seven-eight loop — two bars of 7/8 at tall-grass's 132 bpm, as a
// recipe instead of a recording. It does not reproduce the recording it
// replaces and is not trying to: nothing in this example ships as audio,
// so the groove is written rather than sampled.
//
// The limp is the 3+2+2 grouping. A kick opens each of the three groups —
// eighths 0, 3 and 5 of the seven — and the one on 0 is the bar's own
// downbeat, so it lands hardest. A rim doubles the kick that opens the
// *second* group only, on eighth 3, which is where the seven leans; the
// other groups are left bare so the lean is audible. Eighth hats run
// throughout with seeded drift, so it breathes rather than ticks.
//
// Noise UGens get client-seeded RandSeed args because scsynth's own noise
// seeding is time-based — without this the render would not be
// deterministic, which is the whole reason a program may live in the
// build graph while a model may not. Runs under Field's sc-render
// contract: parameters arrive in the environment, output goes to
// FIELD_OUTPUT, and the render is bit-reproducible for a given FIELD_SEED.
(
var seed = "FIELD_SEED".getenv.asInteger;
var dur = "FIELD_DURATION".getenv.asFloat;
var rate = "FIELD_SAMPLE_RATE".getenv.asInteger;
var out = "FIELD_OUTPUT".getenv;
var chans = "FIELD_CHANNELS".getenv.asInteger;
var eighth = 60 / 132 / 2; // one eighth at 132 bpm, quarter-note tempo
var downbeats = [0, 3, 5]; // 3+2+2: which of the seven eighths open a group
var events, nEighths, score;
thisThread.randSeed = seed;

SynthDef(\grassKick, { |amp = 1.0|
	var env = EnvGen.kr(Env.perc(0.001, 0.24), doneAction: 2);
	var sig = SinOsc.ar(XLine.kr(110, 45, 0.08));
	Out.ar(0, Pan2.ar(sig * env * amp, 0));
}).store;

SynthDef(\grassRim, { |amp = 0.5, seed = 0|
	var env = EnvGen.kr(Env.perc(0.001, 0.07), doneAction: 2);
	var sig;
	RandSeed.ir(1, seed);
	sig = (BPF.ar(WhiteNoise.ar, 2400, 0.6) * 0.8) + (SinOsc.ar(320) * 0.25);
	Out.ar(0, Pan2.ar(sig * env * amp, 0.1));
}).store;

SynthDef(\grassHat, { |amp = 0.1, pan = 0, seed = 0|
	var env = EnvGen.kr(Env.perc(0.001, 0.04), doneAction: 2);
	var sig;
	RandSeed.ir(1, seed);
	sig = HPF.ar(WhiteNoise.ar, 8000);
	Out.ar(0, Pan2.ar(sig * env * amp, pan));
}).store;

events = [];
nEighths = (dur / eighth).round.asInteger;
nEighths.do { |e|
	var t = e * eighth;
	var inBar = e % 7;
	if (downbeats.includes(inBar)) {
		events = events.add([t, Synth.basicNew(\grassKick).newMsg(args: [
			\amp, if (inBar == 0) { 1.0 } { 0.7 }
		])]);
	};
	// The second group only. A rim on every group's opening would even the
	// bar back out, which is the one thing a seven should not sound like.
	if (inBar == 3) {
		events = events.add([t, Synth.basicNew(\grassRim).newMsg(args: [
			\amp, 0.5, \seed, 1000000.rand
		])]);
	};
	events = events.add([t, Synth.basicNew(\grassHat).newMsg(args: [
		\amp, rrand(0.10, 0.20),
		\pan, rrand(-0.3, 0.3),
		\seed, 1000000.rand
	])]);
};
score = Score(events ++ [[dur, [0]]]);
score.recordNRT(
	outputFilePath: out,
	sampleRate: rate,
	headerFormat: "WAV",
	sampleFormat: "int24",
	options: ServerOptions.new.numOutputBusChannels_(chans),
	duration: dur,
	action: { 0.exit }
);
)
