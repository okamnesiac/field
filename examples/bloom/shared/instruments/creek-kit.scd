// creek kit — a two-bar beat at creek's opening 96 bpm, as a recipe.
// Kick on 1 and 3, snare on 2 and 4, eighth hats with seeded velocity and
// placement drift. Noise UGens get client-seeded RandSeed args because
// scsynth's own noise seeding is time-based — without this the render
// would not be deterministic. Runs under Field's sc-render contract:
// parameters arrive in the environment, output goes to FIELD_OUTPUT, and
// the render is bit-reproducible for a given FIELD_SEED.
(
var seed = "FIELD_SEED".getenv.asInteger;
var dur = "FIELD_DURATION".getenv.asFloat;
var rate = "FIELD_SAMPLE_RATE".getenv.asInteger;
var out = "FIELD_OUTPUT".getenv;
var chans = "FIELD_CHANNELS".getenv.asInteger;
var beat = 0.625; // one beat at 96 bpm
var events, nBeats, score;
thisThread.randSeed = seed;

SynthDef(\creekKick, { |amp = 1.0|
	var env = EnvGen.kr(Env.perc(0.001, 0.28), doneAction: 2);
	var sig = SinOsc.ar(XLine.kr(120, 43, 0.09));
	Out.ar(0, Pan2.ar(sig * env * amp, 0));
}).store;

SynthDef(\creekSnare, { |amp = 0.6, seed = 0|
	var env = EnvGen.kr(Env.perc(0.001, 0.16), doneAction: 2);
	var sig;
	RandSeed.ir(1, seed);
	sig = (BPF.ar(WhiteNoise.ar, 1800, 1.2) * 0.7) + (SinOsc.ar(190) * 0.4);
	Out.ar(0, Pan2.ar(sig * env * amp, 0));
}).store;

SynthDef(\creekHat, { |amp = 0.1, pan = 0, seed = 0|
	var env = EnvGen.kr(Env.perc(0.001, 0.05), doneAction: 2);
	var sig;
	RandSeed.ir(1, seed);
	sig = HPF.ar(WhiteNoise.ar, 7000);
	Out.ar(0, Pan2.ar(sig * env * amp, pan));
}).store;

events = [];
nBeats = (dur / beat).round.asInteger;
nBeats.do { |b|
	var t = b * beat;
	if (b % 2 == 0) {
		events = events.add([t, Synth.basicNew(\creekKick).newMsg(args: [\amp, 1.0])]);
	} {
		events = events.add([t, Synth.basicNew(\creekSnare).newMsg(args: [
			\amp, 0.6, \seed, 1000000.rand
		])]);
	};
	2.do { |e|
		events = events.add([t + (e * beat / 2),
			Synth.basicNew(\creekHat).newMsg(args: [
				\amp, rrand(0.12, 0.22),
				\pan, rrand(-0.35, 0.35),
				\seed, 1000000.rand
			])
		]);
	};
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
