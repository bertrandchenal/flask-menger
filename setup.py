"""
Flask-Menger
-------------

Provides a web ui for Menger
"""
from setuptools import setup


setup(
    name='flask_menger',
    version='1.0',
    url='https://bitbucket.org/adimian/menger-flask',
    license='MIT',
    author='see AUTHORS',
    author_email='bertrand@adimian.com',
    description='Provides a web ui for Menger',
    long_description=__doc__,
    packages=['flask_menger'],
    zip_safe=False,
    include_package_data=True,
    platforms='any',
    install_requires=[
        'Flask',
        'Menger'

    ],
    classifiers=[
        'Environment :: Web Environment',
        'Intended Audience :: Developers',
        'License :: OSI Approved :: MIT License',
        'Operating System :: OS Independent',
        'Programming Language :: Python',
        'Topic :: Internet :: WWW/HTTP :: Dynamic Content',
        'Topic :: Software Development :: Libraries :: Python Modules'
    ]
)
