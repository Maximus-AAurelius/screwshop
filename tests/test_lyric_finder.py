import sys
import time
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from lyric_finder import find, words_of


def transcript(text, start=0.0, step=0.4):
    return [{'word': w, 'start': round(start + i * step, 3), 'end': round(start + i * step + 0.3, 3)} for i, w in enumerate(text.split())]


HOOK = """I know you strapped, but you still a bitch
Ya talkin' bumpkin cause I know you ain't shit"""


class LyricFinderTest(unittest.TestCase):
    def test_normalises_punctuation(self):
        self.assertEqual(words_of("Ya talkin' bumpkin, NIGGA!"), ['ya', 'talkin', 'bumpkin', 'nigga'])

    def test_finds_phrase_and_lines_despite_misheard_words(self):
        heard = transcript('yeah uh southside ' + 'I know you strap but you still a b**** ya talking pumpkin cuz I know you ain\'t s*** ' + 'keep it trill man')
        match = find(heard, HOOK)[0]
        self.assertEqual(match['start'], heard[3]['start'])
        self.assertEqual(match['end'], heard[20]['end'])
        self.assertEqual(len(match['lines']), 2)
        self.assertEqual(match['lines'][0]['end'], heard[11]['end'])
        self.assertEqual(match['lines'][1]['start'], heard[12]['start'])
        self.assertTrue(match['lines'][1]['heard'].startswith('ya talking'))

    def test_returns_each_repeat_of_a_hook(self):
        hook = 'I know you strapped but you still a bitch'
        heard = transcript('verse words here ' + hook + ' more verse words in the middle ' + hook + ' outro')
        matches = find(heard, hook)
        self.assertEqual(sorted(m['start'] for m in matches[:2]), [heard[3]['start'], heard[18]['start']])

    def test_rejects_words_that_are_not_there(self):
        with self.assertRaises(ValueError):
            find(transcript('nothing like the typed line at all'), 'diamonds and wood candy paint')
        with self.assertRaises(ValueError):  # short phrases must not grab loosely similar words
            find(transcript("I know you strapped but you still a punk you talking bumpkin cause I know you ain't nothing"), 'diamonds and wood candy paint')
        with self.assertRaises(ValueError):
            find(transcript('anything'), '   \n  ')

    def test_full_song_search_is_quick(self):
        song = transcript(' '.join(['filler words from a long rap verse'] * 120) + ' ' + HOOK.replace('\n', ' '))
        began = time.perf_counter()
        find(song, HOOK)
        self.assertLess(time.perf_counter() - began, 10)


if __name__ == '__main__':
    unittest.main()
