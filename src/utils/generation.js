
/**
 * @file Classes, functions, and utilities for generation.
 * 
 * @todo Describe how to create a custom `GenerationConfig`.
 * 
 * @module utils/generation
 */
import { Tensor } from './tensor';
import {
    Callable,
    exists,
} from './core';
import {
    max,
    softmax,
    log_softmax,
    getTopItems,
} from './maths';

/**
 * A class representing a list of logits processors. A logits processor is a function that modifies the logits
 * output of a language model. This class provides methods for adding new processors and applying all processors to a
 * batch of logits.
 *
 * @extends Callable
 */
export class LogitsProcessorList extends Callable {
    /**
     * Constructs a new instance of `LogitsProcessorList`.
     */
    constructor() {
        super();
        this.processors = [];
    }

    /**
     * Adds a new logits processor to the list.
     *
     * @param {LogitsProcessor} item The logits processor function to add.
     */
    push(item) {
        this.processors.push(item);
    }

    /**
     * Adds multiple logits processors to the list.
     *
     * @param {LogitsProcessor[]} items The logits processor functions to add.
     */
    extend(items) {
        this.processors.push(...items);
    }

    /**
     * Applies all logits processors in the list to a batch of logits, modifying them in-place.
     *
     * @param {number[]} input_ids The input IDs for the language model.
     * @param {number[][]} batchedLogits A 2D array of logits, where each row corresponds to a single
     *                                                input sequence in the batch.
     */
    _call(input_ids, batchedLogits) {
        // NOTE: This is different from the Python code, since vanilla JS does not support vectorized operations. 
        // As a result, we apply each processor to each item in the batch.
        for (let logits of batchedLogits) {
            // Modifies logits inplace
            this.processors.forEach(
                func => func(input_ids, logits)
            )
        }
    }

    [Symbol.iterator]() {
        return this.processors.values();
    }
}

/**
 * Base class for processing logits.
 * @extends Callable
 */
export class LogitsProcessor extends Callable {
    /**
     * Apply the processor to the input logits.
     *
     * @abstract
     * @param {Array} input_ids The input ids.
     * @param {Tensor} logits The logits to process.
     * @throws {Error} Throws an error if `_call` is not implemented in the subclass.
     */
    _call(input_ids, logits) {
        throw Error("`_call` should be implemented in a subclass")
    }
}

/**
 * A logits processor that forces a specific token to be generated by the decoder.
 * 
 * @extends LogitsProcessor
 */
export class ForceTokensLogitsProcessor extends LogitsProcessor {
    /**
     * Constructs a new instance of `ForceTokensLogitsProcessor`.
     * 
     * @param {Array} forced_decoder_ids The ids of tokens that should be forced.
     */
    constructor(forced_decoder_ids) {
        super();
        this.force_token_map = Object.fromEntries(forced_decoder_ids ?? []);
    }

    /**
     * Apply the processor to the input logits.
     *
     * @param {Array} input_ids The input ids.
     * @param {any} logits The logits to process.
     * @returns {Array} The processed logits.
     */
    _call(input_ids, logits) {
        let map = this.force_token_map[input_ids.length];
        if (exists(map)) { // There exists a mapping
            logits.data.fill(-Infinity)
            logits.data[map] = 0;
        }
        return logits;
    }
}

/**
 * A LogitsProcessor that forces a BOS token at the beginning of the generated sequence.
 * @extends LogitsProcessor
 */
export class ForcedBOSTokenLogitsProcessor extends LogitsProcessor {
    /**
     * Create a ForcedBOSTokenLogitsProcessor.
     * @param {number} bos_token_id The ID of the beginning-of-sequence token to be forced.
     */
    constructor(bos_token_id) {
        super();
        this.bos_token_id = bos_token_id;
    }

    /**
     * Apply the BOS token forcing to the logits.
     * @param {Array} input_ids The input IDs.
     * @param {Object} logits The logits.
     * @returns {Object} The logits with BOS token forcing.
     */
    _call(input_ids, logits) {
        if (input_ids.length === 1) {
            logits.data.fill(-Infinity)
            logits.data[this.bos_token_id] = 0;
        }
    }
}

/**
 * A logits processor that forces end-of-sequence token probability to 1.
 * 
 * @extends LogitsProcessor
 */
export class ForcedEOSTokenLogitsProcessor extends LogitsProcessor {
    /**
     * Create a ForcedEOSTokenLogitsProcessor.
     * @param {number} max_length Max length of the sequence.
     * @param {number|number[]} forced_eos_token_id The ID of the end-of-sequence token to be forced.
     */
    constructor(max_length, forced_eos_token_id) {
        super();
        this.max_length = max_length;
        this.forced_eos_token_id = forced_eos_token_id;
    }

    /**
     * Apply the processor to input_ids and logits.
     * 
     * @param {number[]} input_ids The input ids.
     * @param {any} logits The logits tensor.
     */
    _call(input_ids, logits) {
        // console.log('call ForcedEOSTokenLogitsProcessor')
        // TODO
    }
}

/**
 * A LogitsProcessor that handles adding timestamps to generated text.
 * @extends LogitsProcessor
 */
export class WhisperTimeStampLogitsProcessor extends LogitsProcessor {
    /**
     * Constructs a new WhisperTimeStampLogitsProcessor.
     * @param {Object} generate_config The config object passed to the `generate()` method of a transformer model.
     * @param {number} generate_config.eos_token_id The ID of the end-of-sequence token.
     * @param {number} generate_config.no_timestamps_token_id The ID of the token used to indicate that a token should not have a timestamp.
     * @param {number[][]} [generate_config.forced_decoder_ids] An array of two-element arrays representing decoder IDs that are forced to appear in the output. The second element of each array indicates whether the token is a timestamp.
     * @param {number} [generate_config.max_initial_timestamp_index] The maximum index at which an initial timestamp can appear.
     */
    constructor(generate_config) {
        super();
        this.eos_token_id = generate_config.eos_token_id;
        this.no_timestamps_token_id = generate_config.no_timestamps_token_id;
        this.timestamp_begin = this.no_timestamps_token_id + 1;

        this.begin_index = (generate_config.forced_decoder_ids || []).length + 2;
        if (generate_config.forced_decoder_ids.slice(-1)[0][1] === this.no_timestamps_token_id) {
            this.begin_index -= 1;
        }
        this.max_initial_timestamp_index = generate_config.max_initial_timestamp_index;

    }

    /**
     * Modify the logits to handle timestamp tokens.
     * @param {Array} input_ids The input sequence of tokens.
     * @param {Tensor} logits The logits output by the model.
     * @returns {Tensor} The modified logits.
     */
    _call(input_ids, logits) {
        // suppress <|notimestamps|> which is handled by without_timestamps
        logits.data[this.no_timestamps_token_id] = -Infinity;

        if (input_ids.length === this.begin_index - 1) {
            logits.data.fill(-Infinity);
            logits.data[this.timestamp_begin] = 0;
            return logits;
        }

        // timestamps have to appear in pairs, except directly before eos_token; mask logits accordingly
        const seq = input_ids.slice(this.begin_index);
        const last_was_timestamp = seq.length >= 1 && seq[seq.length - 1] >= this.timestamp_begin;
        const penultimate_was_timestamp = seq.length < 2 || seq[seq.length - 2] >= this.timestamp_begin;

        if (last_was_timestamp) {
            if (penultimate_was_timestamp) { // has to be non-timestamp
                logits.data.subarray(this.timestamp_begin).fill(-Infinity);
            } else { // cannot be normal text tokens
                logits.data.subarray(0, this.eos_token_id).fill(-Infinity);
            }
        }

        // apply the `max_initial_timestamp` option
        if (input_ids.length === this.begin_index && this.max_initial_timestamp_index !== null) {
            const last_allowed = this.timestamp_begin + this.max_initial_timestamp_index;
            logits.data.subarray(last_allowed + 1).fill(-Infinity);
        }

        // if sum of probability over timestamps is above any other token, sample timestamp
        const logprobs = log_softmax(logits.data);
        const timestamp_logprob = Math.log(logprobs.subarray(this.timestamp_begin).map(Math.exp).reduce((a, b) => a + b));
        const max_text_token_logprob = Math.max(...logprobs.subarray(0, this.timestamp_begin));
        if (timestamp_logprob > max_text_token_logprob) {
            logits.data.subarray(0, this.timestamp_begin).fill(-Infinity);
        }

        return logits;
    }
}

/**
 * A logits processor that disallows ngrams of a certain size to be repeated.
 * 
 * @extends LogitsProcessor
 */
export class NoRepeatNGramLogitsProcessor extends LogitsProcessor {
    /**
     * Create a NoRepeatNGramLogitsProcessor.
     * @param {number} no_repeat_ngram_size The no-repeat-ngram size. All ngrams of this size can only occur once.
     */
    constructor(no_repeat_ngram_size) {
        super();
        this.no_repeat_ngram_size = no_repeat_ngram_size;
    }

    /**
     * Generate n-grams from a sequence of token ids.
     * @param {number[]} prevInputIds List of previous input ids
     * @returns {Map<string, number[]>} Map of generated n-grams
     */
    getNgrams(prevInputIds) {
        const curLen = prevInputIds.length;

        /**@type {number[][]} */
        const ngrams = [];
        for (let j = 0; j < curLen + 1 - this.no_repeat_ngram_size; ++j) {
            const ngram = [];
            for (let k = 0; k < this.no_repeat_ngram_size; ++k) {
                ngram.push(prevInputIds[j + k]);
            }
            ngrams.push(ngram);
        }

        /** @type {Map<string, number[]>} */
        const generatedNgram = new Map();
        for (const ngram of ngrams) {
            const prevNgram = ngram.slice(0, ngram.length - 1);
            const prevNgramKey = JSON.stringify(prevNgram);
            const prevNgramValue = generatedNgram.get(prevNgramKey) ?? [];
            prevNgramValue.push(ngram[ngram.length - 1]);
            generatedNgram.set(prevNgramKey, prevNgramValue);
        }
        return generatedNgram;
    }

    /**
     * Generate n-grams from a sequence of token ids.
     * @param {Map<string, number[]>} bannedNgrams Map of banned n-grams
     * @param {number[]} prevInputIds List of previous input ids
     * @returns {number[]} Map of generated n-grams
     */
    getGeneratedNgrams(bannedNgrams, prevInputIds) {
        const ngramIdx = prevInputIds.slice(prevInputIds.length + 1 - this.no_repeat_ngram_size, prevInputIds.length);
        const banned = bannedNgrams.get(JSON.stringify(ngramIdx)) ?? [];
        return banned;
    }

    /**
     * Calculate banned n-gram tokens
     * @param {number[]} prevInputIds List of previous input ids
     * @returns {number[]} Map of generated n-grams
     */
    calcBannedNgramTokens(prevInputIds) {
        const bannedTokens = [];
        if (prevInputIds.length + 1 < this.no_repeat_ngram_size) {
            // return no banned tokens if we haven't generated no_repeat_ngram_size tokens yet
            return bannedTokens;

        } else {
            const generatedNgrams = this.getNgrams(prevInputIds);
            const bannedTokens = this.getGeneratedNgrams(generatedNgrams, prevInputIds);
            return bannedTokens;
        }
    }

    /**
     * Apply the no-repeat-ngram processor to the logits.
     * @param {Array} input_ids The input IDs.
     * @param {Object} logits The logits.
     * @returns {Object} The logits with no-repeat-ngram processing.
     */
    _call(input_ids, logits) {
        const bannedTokens = this.calcBannedNgramTokens(input_ids);

        for (const token of bannedTokens) {
            logits.data[token] = -Infinity;
        }
        return logits;
    }
}

/**
 * A logits processor that penalises repeated output tokens.
 * 
 * @extends LogitsProcessor
 */
export class RepetitionPenaltyLogitsProcessor extends LogitsProcessor {
    /**
     * Create a RepetitionPenaltyLogitsProcessor.
     * @param {number} penalty The penalty to apply for repeated tokens.
     */
    constructor(penalty) {
        super();
        this.penalty = penalty;
    }

    /**
     * Apply the repetition penalty to the logits.
     * @param {Array} input_ids The input IDs.
     * @param {Object} logits The logits.
     * @returns {Object} The logits with repetition penalty processing.
     */
    _call(input_ids, logits) {
        // Modify the logits corresponding to each element in `input_ids`.
        // As a consequence, the logits corresponding to tokens that appear
        // many times in the output will be penalised more.
        for (const input_id of input_ids) {
            if (logits.data[input_id] < 0) {
                logits.data[input_id] *= this.penalty;
            } else {
                logits.data[input_id] /= this.penalty;
            }
        }
        return logits
    }
}

/**
 * Class that holds a configuration for a generation task.
 */
export class GenerationConfig {
    /**
     * Create a GenerationConfig object
     * @param {Object} [kwargs={}] The configuration parameters. If not set, the default values are used.
     * @param {number} [kwargs.max_length=20] The maximum length the generated tokens can have. Corresponds to the length of the input prompt + `max_new_tokens`. Its effect is overridden by `max_new_tokens`, if also set.
     * @param {number} [kwargs.max_new_tokens=null] The maximum numbers of tokens to generate, ignoring the number of tokens in the prompt.
     * @param {number} [kwargs.min_length=0] The minimum length of the sequence to be generated. Corresponds to the length of the input prompt + `min_new_tokens`. Its effect is overridden by `min_new_tokens`, if also set.
     * @param {number} [kwargs.min_new_tokens=null] The minimum numbers of tokens to generate, ignoring the number of tokens in the prompt.
     * @param {boolean|"never"} [kwargs.early_stopping=false] Controls the stopping condition for beam-based methods, like beam-search. It accepts the following values:
     * - `true`, where the generation stops as soon as there are `num_beams` complete candidates;
     * - `false`, where an heuristic is applied and the generation stops when is it very unlikely to find better candidates;
     * - `"never"`, where the beam search procedure only stops when there cannot be better candidates (canonical beam search algorithm).
     * @param {number} [kwargs.max_time=null] The maximum amount of time you allow the computation to run for in seconds. Generation will still finish the current pass after allocated time has been passed.
     *
     * @param {boolean} [kwargs.do_sample=false] Whether or not to use sampling; use greedy decoding otherwise.
     * @param {number} [kwargs.num_beams=1] Number of beams for beam search. 1 means no beam search.
     * @param {number} [kwargs.num_beam_groups=1] Number of groups to divide `num_beams` into in order to ensure diversity among different groups of beams. See [this paper](https://arxiv.org/pdf/1610.02424.pdf) for more details.
     * @param {number} [kwargs.penalty_alpha=null] The values balance the model confidence and the degeneration penalty in contrastive search decoding.
     * @param {boolean} [kwargs.use_cache=true] Whether or not the model should use the past last key/values attentions (if applicable to the model) to speed up decoding.
     *
     * @param {number} [kwargs.temperature=1.0] The value used to modulate the next token probabilities.
     * @param {number} [kwargs.top_k=50] The number of highest probability vocabulary tokens to keep for top-k-filtering.
     * @param {number} [kwargs.top_p=1.0] If set to float < 1, only the smallest set of most probable tokens with probabilities that add up to `top_p` or higher are kept for generation.
     * @param {number} [kwargs.typical_p=1.0] Local typicality measures how similar the conditional probability of predicting a target token next is to the expected conditional probability of predicting a random token next, given the partial text already generated. If set to float < 1, the smallest set of the most locally typical tokens with probabilities that add up to `typical_p` or higher are kept for generation. See [this paper](https://arxiv.org/pdf/2202.00666.pdf) for more details.
     * @param {number} [kwargs.epsilon_cutoff=0.0] If set to float strictly between 0 and 1, only tokens with a conditional probability greater than `epsilon_cutoff` will be sampled. In the paper, suggested values range from 3e-4 to 9e-4, depending on the size of the model. See [Truncation Sampling as Language Model Desmoothing](https://arxiv.org/abs/2210.15191) for more details.
     * @param {number} [kwargs.eta_cutoff=0.0] Eta sampling is a hybrid of locally typical sampling and epsilon sampling. If set to float strictly between 0 and 1, a token is only considered if it is greater than either `eta_cutoff` or `sqrt(eta_cutoff) * exp(-entropy(softmax(next_token_logits)))`. The latter term is intuitively the expected next token probability, scaled by `sqrt(eta_cutoff)`. In the paper, suggested values range from 3e-4 to 2e-3, depending on the size of the model. See [Truncation Sampling as Language Model Desmoothing](https://arxiv.org/abs/2210.15191) for more details.
     * @param {number} [kwargs.diversity_penalty=0.0] This value is subtracted from a beam's score if it generates a token same as any beam from other group at a particular time. Note that `diversity_penalty` is only effective if `group beam search` is enabled.
     * @param {number} [kwargs.repetition_penalty=1.0] The parameter for repetition penalty. 1.0 means no penalty. See [this paper](https://arxiv.org/pdf/1909.05858.pdf) for more details.
     * @param {number} [kwargs.encoder_repetition_penalty=1.0] The paramater for encoder_repetition_penalty. An exponential penalty on sequences that are not in the original input. 1.0 means no penalty.
     * @param {number} [kwargs.length_penalty=1.0] Exponential penalty to the length that is used with beam-based generation. It is applied as an exponent to the sequence length, which in turn is used to divide the score of the sequence. Since the score is the log likelihood of the sequence (i.e. negative), `length_penalty` > 0.0 promotes longer sequences, while `length_penalty` < 0.0 encourages shorter sequences.
     * @param {number} [kwargs.no_repeat_ngram_size=0] If set to int > 0, all ngrams of that size can only occur once.
     * @param {number[][]} [kwargs.bad_words_ids=null] List of token ids that are not allowed to be generated. In order to get the token ids of the words that should not appear in the generated text, use `(await tokenizer(bad_words, {add_prefix_space: true, add_special_tokens: false})).input_ids`.
     * @param {number[][]|number[][][]} [kwargs.force_words_ids=null] List of token ids that must be generated. If given a `number[][]`, this is treated as a simple list of words that must be included, the opposite to `bad_words_ids`. If given `number[][][]`, this triggers a [disjunctive constraint](https://github.com/huggingface/transformers/issues/14081), where one can allow different forms of each word.
     * @param {boolean} [kwargs.renormalize_logits=false] Whether to renormalize the logits after applying all the logits processors or warpers (including the custom ones). It's highly recommended to set this flag to `true` as the search algorithms suppose the score logits are normalized but some logit processors or warpers break the normalization.
     * @param {Object[]} [kwargs.constraints=null] Custom constraints that can be added to the generation to ensure that the output will contain the use of certain tokens as defined by `Constraint` objects, in the most sensible way possible.
     * 
     * @param {number} [kwargs.forced_bos_token_id=null] The id of the token to force as the first generated token after the `decoder_start_token_id`. Useful for multilingual models like mBART where the first generated token needs to be the target language token.
     * @param {number|number[]} [kwargs.forced_eos_token_id=null] The id of the token to force as the last generated token when `max_length` is reached. Optionally, use a list to set multiple *end-of-sequence* tokens.
     * @param {boolean} [kwargs.remove_invalid_values=false] Whether to remove possible *nan* and *inf* outputs of the model to prevent the generation method to crash. Note that using `remove_invalid_values` can slow down generation.
     * @param {number[]} [kwargs.exponential_decay_length_penalty=null] This Tuple adds an exponentially increasing length penalty, after a certain amount of tokens have been generated. The tuple shall consist of: `(start_index, decay_factor)` where `start_index` indicates where penalty starts and `decay_factor` represents the factor of exponential decay.
     * @param {number[]} [kwargs.suppress_tokens=null] A list of tokens that will be suppressed at generation. The `SupressTokens` logit processor will set their log probs to `-inf` so that they are not sampled.
     * @param {number[]} [kwargs.begin_suppress_tokens=null] A list of tokens that will be suppressed at the beginning of the generation. The `SupressBeginTokens` logit processor will set their log probs to `-inf` so that they are not sampled.
     * @param {number[][]} [kwargs.forced_decoder_ids=null] A list of pairs of integers which indicates a mapping from generation indices to token indices that will be forced before sampling. For example, `[[1, 123]]` means the second generated token will always be a token of index 123.
     * 
     * @param {number} [kwargs.num_return_sequences=1] The number of independently computed returned sequences for each element in the batch.
     * @param {boolean} [kwargs.output_attentions=false] Whether or not to return the attentions tensors of all attention layers. See `attentions` under returned tensors for more details.
     * @param {boolean} [kwargs.output_hidden_states=false] Whether or not to return the hidden states of all layers. See `hidden_states` under returned tensors for more details.
     * @param {boolean} [kwargs.output_scores=false] Whether or not to return the prediction scores. See `scores` under returned tensors for more details.
     * @param {boolean} [kwargs.return_dict_in_generate=false] Whether or not to return a `ModelOutput` instead of a plain tuple.
     * 
     * @param {number} [kwargs.pad_token_id=null] The id of the *padding* token.
     * @param {number} [kwargs.bos_token_id=null] The id of the *beginning-of-sequence* token.
     * @param {number|number[]} [kwargs.eos_token_id=null] The id of the *end-of-sequence* token. Optionally, use a list to set multiple *end-of-sequence* tokens.
     * 
     * @param {number} [kwargs.encoder_no_repeat_ngram_size=0] If set to int > 0, all ngrams of that size that occur in the `encoder_input_ids` cannot occur in the `decoder_input_ids`.
     * @param {number} [kwargs.decoder_start_token_id=null] If an encoder-decoder model starts decoding with a different token than *bos*, the id of that token.
     * 
     * @param {Object} [kwargs.generation_kwargs={}] Additional generation kwargs will be forwarded to the `generate` function of the model. Kwargs that are not present in `generate`'s signature will be used in the model forward pass.
     */
    constructor(kwargs = {}) {
        // Parameters that control the length of the output
        this.max_length = kwargs.max_length ?? 20;
        this.max_new_tokens = kwargs.max_new_tokens ?? null;
        this.min_length = kwargs.min_length ?? 0;
        this.min_new_tokens = kwargs.min_new_tokens ?? null;
        this.early_stopping = kwargs.early_stopping ?? false;
        this.max_time = kwargs.max_time ?? null;

        // Parameters that control the generation strategy used
        this.do_sample = kwargs.do_sample ?? false;
        this.num_beams = kwargs.num_beams ?? 1;
        this.num_beam_groups = kwargs.num_beam_groups ?? 1;
        this.penalty_alpha = kwargs.penalty_alpha ?? null;
        this.use_cache = kwargs.use_cache ?? true;

        // Parameters for manipulation of the model output logits
        this.temperature = kwargs.temperature ?? 1.0;
        this.top_k = kwargs.top_k ?? 50;
        this.top_p = kwargs.top_p ?? 1.0;
        this.typical_p = kwargs.typical_p ?? 1.0;
        this.epsilon_cutoff = kwargs.epsilon_cutoff ?? 0.0;
        this.eta_cutoff = kwargs.eta_cutoff ?? 0.0;
        this.diversity_penalty = kwargs.diversity_penalty ?? 0.0;
        this.repetition_penalty = kwargs.repetition_penalty ?? 1.0;
        this.encoder_repetition_penalty = kwargs.encoder_repetition_penalty ?? 1.0;
        this.length_penalty = kwargs.length_penalty ?? 1.0;
        this.no_repeat_ngram_size = kwargs.no_repeat_ngram_size ?? 0;
        this.bad_words_ids = kwargs.bad_words_ids ?? null;
        this.force_words_ids = kwargs.force_words_ids ?? null;
        this.renormalize_logits = kwargs.renormalize_logits ?? false;
        this.constraints = kwargs.constraints ?? null;
        this.forced_bos_token_id = kwargs.forced_bos_token_id ?? null;
        this.forced_eos_token_id = kwargs.forced_eos_token_id ?? null;
        this.remove_invalid_values = kwargs.remove_invalid_values ?? false;
        this.exponential_decay_length_penalty = kwargs.exponential_decay_length_penalty ?? null;
        this.suppress_tokens = kwargs.suppress_tokens ?? null;
        this.begin_suppress_tokens = kwargs.begin_suppress_tokens ?? null;
        this.forced_decoder_ids = kwargs.forced_decoder_ids ?? null;

        // Parameters that define the output variables of `generate`
        this.num_return_sequences = kwargs.num_return_sequences ?? 1;
        this.output_attentions = kwargs.output_attentions ?? false;
        this.output_hidden_states = kwargs.output_hidden_states ?? false;
        this.output_scores = kwargs.output_scores ?? false;
        this.return_dict_in_generate = kwargs.return_dict_in_generate ?? false;

        // Special tokens that can be used at generation time
        this.pad_token_id = kwargs.pad_token_id ?? null;
        this.bos_token_id = kwargs.bos_token_id ?? null;
        this.eos_token_id = kwargs.eos_token_id ?? null;

        // Generation parameters exclusive to encoder-decoder models
        this.encoder_no_repeat_ngram_size = kwargs.encoder_no_repeat_ngram_size ?? 0;
        this.decoder_start_token_id = kwargs.decoder_start_token_id ?? null;

        // Wild card
        this.generation_kwargs = kwargs.generation_kwargs ?? {};
    }
}


/**
 * Sampler is a base class for all sampling methods used for text generation.
 */
export class Sampler extends Callable {
    /**
     * Creates a new Sampler object with the specified temperature.
     * @param {number} temperature The temperature to use when sampling. Higher values result in more random samples.
     */
    constructor(temperature) {
        super();
        this.temperature = temperature;
    }

    /**
     * Executes the sampler, using the specified logits.
     * @param {any} logits
     * @param {number} index
     * @returns {void}
     */
    _call(logits, index = -1) {
        // Sample from logits, of dims [batch, sequence_length, vocab_size].
        // If index is specified, sample from [batch, index, vocab_size].
        return this.sample(logits, index);
    }

    /**
     * Abstract method for sampling the logits.
     * @param {any} logits
     * @param {number} index
     * @throws {Error}
     */
    sample(logits, index) {
        throw Error("sample should be implemented in subclasses.")
    }

    /**
     * Returns the specified logits as an array, with temperature applied.
     * @param {any} logits
     * @param {number} index
     * @returns {Array}
     */
    getLogits(logits, index) {
        let vocabSize = logits.dims[2];

        let logs = logits.data;

        if (index === -1) {
            logs = logs.slice(-vocabSize);
        } else {
            let startIndex = index * vocabSize;
            logs = logs.slice(startIndex, startIndex + vocabSize);
        }

        // add temperature
        if (this.temperature > 0) {
            logs = logs.map(x => x / this.temperature)
        }
        return logs;
    }

    /**
     * Selects an item randomly based on the specified probabilities.
     * @param {Array} probabilities An array of probabilities to use for selection.
     * @returns {number} The index of the selected item.
     */
    randomSelect(probabilities) {
        // Return index of chosen item
        let sumProbabilities = probabilities.reduce((acc, curr) => acc + curr, 0);

        let r = Math.random() * sumProbabilities;
        for (let i = 0; i < probabilities.length; ++i) {
            r -= probabilities[i];
            if (r <= 0) {
                return i;
            }
        }
        return 0; // return first (most probable) as a fallback
    }

    /**
     * Returns a Sampler object based on the specified options.
     * @param {Object} generation_config An object containing options for the sampler.
     * @returns {Sampler} A Sampler object.
     */
    static getSampler(generation_config) {
        if (generation_config.num_beams > 1) {
            return new BeamSearchSampler(
                generation_config.temperature,
                generation_config.num_beams,
                generation_config.do_sample,
                generation_config.top_k,
            );

        } else if (generation_config.do_sample) {
            return new TopKSampler(
                generation_config.temperature,
                generation_config.top_k,
            );

        } else {
            if (generation_config.num_return_sequences > 1) {
                throw Error(`num_return_sequences has to be 1 when doing greedy search, but is ${generation_config.num_return_sequences}.`)
            }
            return new GreedySampler(generation_config.temperature);
        }
    }
}

/**
 * Class representing a Greedy Sampler.
 * @extends Sampler
 */
class GreedySampler extends Sampler {
    /**
     * Sample the maximum probability of a given logits tensor.
     * @param {any} logits
     * @param {number} [index=-1]
     * @returns {Array} An array with a single tuple, containing the index of the maximum value and a meaningless score (since this is a greedy search).
     */
    sample(logits, index = -1) {
        // NOTE: no need to do log_softmax here since we only take the maximum
        let logs = this.getLogits(logits, index);
        let argmax = max(logs)[1];

        // Note: score is meaningless in this context, since we are performing
        // greedy search (p = 1 => log(p) = 0)
        return [
            [argmax, 0]
        ];
    }
}

/**
 * Class representing a TopKSampler.
 * @extends Sampler
 */
class TopKSampler extends Sampler {
    /**
     * Create a TopKSampler.
     * @param {number} temperature
     * @param {number} k
     */
    constructor(temperature, k) {
        super(temperature);
        this.k = k;
    }

    /**
     * Sample from the logits using the top-k sampling strategy.
     * @param {any} logits
     * @param {number} index
     * @returns {Array}
     */
    sample(logits, index = -1) {
        let [batchSize, seqLength, vocabSize] = logits.dims;
        let k = vocabSize;
        if (this.k > 0) {
            k = Math.min(this.k, k);
        }

        let logs = this.getLogits(logits, index);

        // Get top k tokens
        let topLogits = getTopItems(logs, k);

        // Compute softmax over logits
        let probabilities = softmax(topLogits.map(x => x[1]));

        let sampledIndex = this.randomSelect(probabilities);

        let tokenId = topLogits[sampledIndex][0];
        let score = Math.log(probabilities[sampledIndex]);
        return [
            [tokenId, score]
        ];
    }
}

/**
 * Class representing a beam search sampler for generating sequences.
 * @extends Sampler
 */
class BeamSearchSampler extends Sampler {
    /**
   * Create a BeamSearchSampler.
   * @param {number} temperature
   * @param {number} num_beams
   * @param {boolean} do_sample
   * @param {number} top_k
   */
    constructor(temperature, num_beams, do_sample, top_k) {
        super(temperature);
        this.num_beams = num_beams; // maximum number of beams
        this.do_sample = do_sample; // if true, perform multinomial sampling

        this.top_k = top_k; // if do_sample, sample from top k items
    }

    /**
   * Samples from the logits to generate a sequence using beam search.
   * @param {any} logits The logits to sample from.
   * @param {number} [index=-1] The index to sample from, if applicable.
   * @returns {Array} An array of arrays containing tokens and scores.
   */
    sample(logits, index = -1) {

        let logs = this.getLogits(logits, index);

        if (this.do_sample || this.top_k > 0) {
            const [batchSize, seqLength, vocabSize] = logits.dims;

            let k = vocabSize;
            if (this.top_k > 0) {
                k = Math.min(this.top_k, k);
            }
            const topLogits = getTopItems(logs, k);

            // Compute softmax over top k logits
            const probabilities = softmax(topLogits.map(x => x[1]));

            return Array.from({ length: this.num_beams }, () => {
                const sampledIndex = this.randomSelect(probabilities);
                const tokenId = topLogits[sampledIndex][0];
                return [tokenId, Math.log(probabilities[sampledIndex])];
            });

        } else {
            // first perform log softmax to get scores over whole distribution
            const logProbabilities = log_softmax(logs);
            const topLogits = getTopItems(logProbabilities, this.num_beams);
            return topLogits;
        }
    }
}
